"""Offline tests for tools/: a simulated Pico, voltage controller and card. No serial port or PCI device is opened.

Run: GA100VFI_HOST=<pico-ga100vfi clone>/host python3 -I tests/test_tools.py
(needs pyserial, which the ga100vfi package imports).
"""
import contextlib
import io
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
if os.environ.get("GA100VFI_HOST"):
    sys.path.insert(0, os.environ["GA100VFI_HOST"])

import vfi_common as vc  # noqa: E402
from ga100vfi.glitch import Report  # noqa: E402

BDF = "0000:05:00.0"


class Sim:
    """Card + controller state. outcome_fn(attempt) -> under|lost|poisoned|over|hit|goldilocks."""

    def __init__(self, outcome_fn=lambda a: "under", fw="clk=150 MHz  last reset: power-on  fw=lab-psr1"):
        self.e1, self.vout_code, self.crashed, self.link = vc.E1_GPU, 0x7E, False, True
        self.state = "stock"
        self.outcome_fn, self.fw = outcome_fn, fw
        self.report_e1 = None                   # set to make the next shots report this E1 (NO DIP tests)
        self.events, self.cfg_reads, self.bad_cfg_reads = [], 0, 0
        self.link_after_held_reset = True
        self.crash_after_handback = False
        self.profile = {0xBA: 0x000E, 0xB9: 0x0039, 0x30: 0xCE64, 0x31: 0x1872, 0x32: 0x7F81, 0x45: 0x7018}

    def read_vout(self):
        if self.e1 == vc.E1_PMBUS:
            return 746
        return 301 if self.crashed else 695

    def pex_rst(self):
        self.events.append(("r", self.e1))
        if self.e1 == vc.E1_PMBUS:
            self.crashed = not self.link_after_held_reset
        self.link = not self.crashed
        self.state = "stock"


class FakeCard:
    def __init__(self, sim):
        self.sim, self.closed = sim, False

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()

    def close(self):
        self.closed = True

    def cmd(self, line, **kw):
        s = self.sim
        s.events.append(("cmd", line))
        if line == "r":
            s.pex_rst()
            return "pex_rst pulse 100 ms"
        if line == "z":
            return f"cml=0x00 pwd=1 e1=0x{s.e1:04x} vout=0x0000"
        if line == "u":
            return "MATCH"
        return ""

    def status(self):
        return self.sim.fw

    def lock_status(self):
        return True, self.sim.e1

    def unlock(self):
        return True

    def read(self, addr, reg, n):
        s = self.sim
        if reg == vc.REG_READ_VOUT:
            v = s.read_vout()
        elif reg == vc.REG_READ_TEMP1:
            v = 385
        elif reg in s.profile:
            v = s.profile[reg]
        else:
            v = 0x7E
        return bytes((v & 0xFF, v >> 8))

    def write(self, addr, reg, data):
        s = self.sim
        s.events.append(("w", reg, bytes(data).hex()))
        if reg == vc.REG_CTRL_MODE:
            s.e1 = data[0] | data[1] << 8
        return "I2C OK"

    def revert(self):
        s = self.sim
        s.events.append(("revert",))
        s.e1 = vc.E1_GPU
        if s.crash_after_handback:
            s.crashed, s.link = True, False
        return "revert vout=1 mode=1"

    def attempt(self, a):
        s = self.sim
        s.events.append(("g", a.command()))
        s.e1 = vc.E1_PMBUS          # revert=0: the rail stays held at stock after the dip
        o = s.outcome_fn(a)
        s.crashed = o == "lost"
        s.link = not s.crashed
        s.state = o
        e1 = s.report_e1 if s.report_e1 is not None else s.e1
        return Report(True, e1, None, 0, "glitch done")

    def trace(self):
        return [400] * 60 + [300] * 20 + [880] * 20


REGS = {  # outcome -> (FUSECTRL, DSOV, CRC, PLM)
    "under": (0x00040000, 1, 0x55, 0x0), "over": (0x00040000, 0, 0x00, 0xFFFFFEFE),
    "hit": (0x00040000, 0, 0x55, 0xFFFFFEFE), "goldilocks": (0x00040000, 0, 0x55, 0xFFFFFFFF),
    "poisoned": (0xBADF510E, 0, 0, 0), "stock": (0x00040000, 1, 0x55, 0x0),
    "dsov_poisoned": (0x00040000, 0xBADF1701, 0, 0), "bad0": (0xBAD00100, 0, 0, 0),
}


class FakeBar:
    def __init__(self, sim):
        self.sim, self.reads, self.writes = sim, [], []

    def __call__(self, bdf, size=None):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *a):
        pass

    def rd32(self, off):
        ctrl, dsov, crc, plm = REGS[self.sim.state]
        self.reads.append(off)
        if self.sim.state in ("poisoned", "bad0") and off != vc.FUSECTRL:
            raise AssertionError(f"BAR0 read {off:#x} on a poisoned controller")
        if self.sim.state == "dsov_poisoned" and off not in (vc.FUSECTRL, 0x820084):
            raise AssertionError(f"BAR0 read {off:#x} after a 0xBADF DSOV")
        return {vc.FUSECTRL: ctrl, 0x820084: dsov, 0x824314: 0x12345678, 0x820040: 1, 0x8200FC: plm,
                0x820070: crc}.get(off, 0)

    def wr32(self, off, v):
        self.writes.append((off, v))


class Rig:
    """Patches vfi_common's hardware entry points onto a Sim."""

    def __init__(self, sim):
        self.sim, self.bar = sim, FakeBar(sim)
        self.saved = {}

    def cfg(self, bdf, off=0):
        s = self.sim
        s.cfg_reads += 1
        s.events.append(("cfg", s.e1, s.crashed))
        if s.e1 == vc.E1_GPU and s.crashed:
            s.bad_cfg_reads += 1      # the host-freeze case: config read on a browned-out card
        return vc.DEVICE_8GB if s.link else 0xFFFFFFFF

    def restore(self, bdf, wait_s=0.25, settle_s=0.15):
        self.sim.events.append(("restore", self.sim.e1, self.sim.crashed))
        return self.sim.link

    def __enter__(self):
        tmp = tempfile.mkdtemp()
        os.environ["VFI_STATE_DIR"] = tmp
        p = {"cfg_dword": self.cfg, "restore": self.restore, "Bar0": self.bar,
             "open_card": lambda port: FakeCard(self.sim),
             "check_card": lambda bdf, devices=("0x20c2",): {"vendor": "0x10de", "device": "0x20c2",
                                                             "driver": "pci-stub"},
             "host_checks": lambda bdf, devices=("0x20c2",): {"vendor": "0x10de", "device": "0x20c2",
                                                              "driver": "pci-stub"},
             "boot_id": lambda: "test-boot"}
        for k, v in p.items():
            self.saved[k] = getattr(vc, k)
            setattr(vc, k, v)
        self.sleep = vc.time.sleep
        vc.time.sleep = lambda s: None
        return self

    def __exit__(self, *a):
        vc.time.sleep = self.sleep
        for k, v in self.saved.items():
            setattr(vc, k, v)


def run_tool(mod, argv):
    import importlib
    m = importlib.import_module(mod)
    old = sys.argv
    sys.argv = [mod + ".py"] + argv
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            rc = vc.main_guard(m.main)
    finally:
        sys.argv = old
    return rc, buf.getvalue()


ARGS = ["--bdf", BDF, "--port", "/dev/fake"]


class ParkTests(unittest.TestCase):
    def test_crashed_card_is_held_before_any_config_read(self):
        sim = Sim()
        sim.crashed, sim.link = True, False          # GPU asks for the floor
        with Rig(sim):
            r = vc.park(FakeCard(sim), BDF)
        self.assertTrue(r.ok, r.line())
        self.assertEqual(sim.bad_cfg_reads, 0)
        first_cfg = next(i for i, e in enumerate(sim.events) if e[0] == "cfg")
        first_r = next(i for i, e in enumerate(sim.events) if e[0] == "r")
        self.assertLess(first_r, first_cfg)
        self.assertEqual(sim.e1, vc.E1_GPU)

    def test_link_not_back_leaves_rail_held(self):
        sim = Sim()
        sim.link_after_held_reset = False
        with Rig(sim):
            r = vc.park(FakeCard(sim), BDF)
        self.assertFalse(r.ok)
        self.assertEqual(sim.e1, vc.E1_PMBUS)
        self.assertNotIn(("revert",), sim.events)
        self.assertEqual(sim.bad_cfg_reads, 0)

    def test_brownout_after_handback_is_not_read(self):
        sim = Sim()
        sim.crash_after_handback = True
        with Rig(sim):
            r = vc.park(FakeCard(sim), BDF)
        self.assertFalse(r.ok)
        self.assertEqual(sim.e1, vc.E1_PMBUS)       # taken back to stock
        self.assertEqual(sim.bad_cfg_reads, 0)

    def test_park_tool_exit_codes(self):
        sim = Sim()
        with Rig(sim):
            rc, out = run_tool("vfi_park", ARGS)
        self.assertEqual(rc, 0, out)
        sim = Sim()
        sim.link_after_held_reset = False
        with Rig(sim):
            rc, out = run_tool("vfi_park", ARGS)
        self.assertEqual(rc, 4, out)


class ShotTests(unittest.TestCase):
    def test_poisoned_reads_nothing_else(self):
        sim = Sim(lambda a: "poisoned")
        with Rig(sim) as rig:
            card = FakeCard(sim)
            card.attempt(vc.make_attempt(331, -60, 750, -20, 3, 198, 150, 117, 1))
            s = vc.read_outcome(BDF, 0.25)
        self.assertEqual(s.outcome, "poisoned")
        self.assertEqual(rig.bar.reads, [vc.FUSECTRL])

    def test_bad0_fusectrl_reads_nothing_else(self):
        sim = Sim(lambda a: "bad0")                    # the fuse unit did not answer: the runner stops here too
        with Rig(sim) as rig:
            card = FakeCard(sim)
            card.attempt(vc.make_attempt(331, -60, 750, -20, 3, 198, 150, 117, 1))
            s = vc.read_outcome(BDF, 0.25)
        self.assertEqual(s.outcome, "poisoned")
        self.assertEqual(rig.bar.reads, [vc.FUSECTRL])

    def test_poisoned_dsov_reads_nothing_more(self):
        sim = Sim(lambda a: "dsov_poisoned")
        with Rig(sim) as rig:
            card = FakeCard(sim)
            card.attempt(vc.make_attempt(331, -60, 750, -20, 3, 198, 150, 117, 1))
            s = vc.read_outcome(BDF, 0.25)
        self.assertEqual(s.outcome, "poisoned")
        self.assertEqual(rig.bar.reads, [vc.FUSECTRL, vc.FUSECTRL, 0x820084])
        self.assertEqual(rig.bar.writes, [])

    def test_classify_writes_nothing_by_default(self):
        old = os.environ.pop("CLASSIFY_WRITE", None)
        try:
            sim = Sim(lambda a: "goldilocks")
            with Rig(sim) as rig:
                card = FakeCard(sim)
                card.attempt(vc.make_attempt(356, -60, 750, -20, 3, 198, 150, 117, 1))
                self.assertEqual(vc.read_outcome(BDF, 0.25).outcome, "goldilocks")
            self.assertEqual(rig.bar.writes, [])
        finally:
            if old is not None:
                os.environ["CLASSIFY_WRITE"] = old

    def test_no_dip_stops_the_run(self):
        sim = Sim(lambda a: "under")
        sim.report_e1 = vc.E1_GPU                # the controller handed back / ignored the shot
        with Rig(sim):
            rc, out = run_tool("vfi_hunt", ARGS + ["--budget", "5"])
        self.assertEqual(rc, 3, out)
        self.assertIn("NO DIP", out)
        self.assertEqual(sum(1 for e in sim.events if e[0] == "g"), 1)

    def test_outcome_mapping(self):
        for o in ("under", "over", "hit", "goldilocks"):
            sim = Sim(lambda a, o=o: o)
            with Rig(sim):
                card = FakeCard(sim)
                card.attempt(vc.make_attempt(356, -60, 750, -20, 3, 198, 150, 117, 1))
                self.assertEqual(vc.read_outcome(BDF, 0.25).outcome, o)

    def test_bounds(self):
        with self.assertRaises(vc.BenchStop):
            vc.make_attempt(250, -60, 750, -20, 3, 198, 150, 117, 1)
        with self.assertRaises(vc.BenchStop):
            vc.make_attempt(356, -60, 900, -20, 3, 198, 150, 117, 1)
        with self.assertRaises(vc.BenchStop):
            vc.make_attempt(356, -60, 750, -20, 9, 198, 150, 117, 1)

    def test_stock_firmware_refused_for_fast_profile(self):
        sim = Sim(fw="clk=150 MHz  last reset: power-on")
        with Rig(sim):
            rc, out = run_tool("vfi_hunt", ARGS + ["--budget", "5"])
        self.assertEqual(rc, 3, out)
        self.assertNotIn(("g",), [e[:1] for e in sim.events])

    def test_tainted_profile_refused(self):
        sim = Sim()
        sim.profile[0x31] = vc.PROFILE_FAST[0x31]
        with Rig(sim):
            rc, out = run_tool("vfi_hunt", ARGS + ["--budget", "5"])
        self.assertEqual(rc, 3, out)
        self.assertIn("fast value", out)


class HuntTests(unittest.TestCase):
    def test_holds_goldilocks_without_park(self):
        n = {"i": 0}

        def fn(a):
            n["i"] += 1
            return "goldilocks" if n["i"] == 4 else ("lost" if n["i"] == 2 else "under")
        sim = Sim(fn)
        with Rig(sim):
            rc, out = run_tool("vfi_hunt", ARGS + ["--budget", "20"])
        self.assertEqual(rc, 0, out)
        self.assertIn("STATE HELD", out)
        last_g = max(i for i, e in enumerate(sim.events) if e[0] == "g")
        self.assertNotIn(("revert",), sim.events[last_g:])
        self.assertNotIn("r", [e[0] for e in sim.events[last_g:]])
        self.assertEqual(sim.e1, vc.E1_PMBUS)
        self.assertEqual(sim.bad_cfg_reads, 0)

    def test_no_hit_parks_and_returns_1(self):
        sim = Sim(lambda a: "lost")
        with Rig(sim):
            rc, out = run_tool("vfi_hunt", ARGS + ["--budget", "6"])
        self.assertEqual(rc, 1, out)
        self.assertEqual(sim.e1, vc.E1_GPU)
        self.assertFalse(sim.crashed)
        self.assertEqual(sim.bad_cfg_reads, 0)

    def test_poison_ends_the_run_and_parks(self):
        n = {"i": 0}

        def fn(a):
            n["i"] += 1
            return "poisoned" if n["i"] == 2 else "under"
        for tool, extra in (("vfi_hunt", ["--budget", "20"]),
                            ("vfi_edge", ["--v-dips", "356", "--t-dip-start", "-60", "--cell", "5"])):
            with self.subTest(tool=tool):
                n["i"] = 0
                sim = Sim(fn)
                with Rig(sim):
                    rc, out = run_tool(tool, ARGS + extra)
                self.assertEqual(rc, 3, out)
                self.assertIn("poisoned the fuse controller", out)
                self.assertEqual(len([e for e in sim.events if e[0] == "g"]), 2)   # no shot after the poison
                self.assertEqual(sim.e1, vc.E1_GPU)                              # parked on the way out

    def test_boot_ledger_cap(self):
        sim = Sim(lambda a: "under")
        with Rig(sim):
            rc, out = run_tool("vfi_hunt", ARGS + ["--budget", "50", "--max-shots-per-boot", "7"])
        self.assertEqual(rc, 3, out)
        self.assertEqual(sum(1 for e in sim.events if e[0] == "g"), 7)
        self.assertEqual(sim.e1, vc.E1_GPU)          # parked on the way out

    def test_first_shot_parks_before_every_shot(self):
        sim = Sim(lambda a: "under")
        with Rig(sim):
            rc, out = run_tool("vfi_hunt", ARGS + ["--budget", "4", "--first-shot"])
        kinds = [e[0] for e in sim.events if e[0] in ("g", "r")]
        self.assertEqual(kinds, ["r", "g", "r", "g", "r", "g", "r", "g", "r"])


class EdgeTests(unittest.TestCase):
    def test_walks_to_the_edge_and_back(self):
        edge = -131                                    # lost at t_dip >= edge, under before it

        def fn(a):
            return "lost" if a.t_dip_us >= edge else "under"
        sim = Sim(fn)
        with Rig(sim):
            rc, out = run_tool("vfi_edge", ARGS + ["--v-dips", "356,356,362", "--t-dip-start", "-135",
                                                   "--crash-budget", "30", "--max-cells", "20"])
        self.assertEqual(rc, 1, out)
        tds = [int(l.split("t_dip=")[1].split(":")[0]) for l in out.splitlines() if l.startswith("cell ")]
        self.assertEqual(tds[:5], [-135, -134, -133, -132, -131])
        self.assertEqual(tds[5], -132)                 # stepped back after the lost cell
        self.assertIn("crash budget reached", out)
        self.assertEqual(sim.bad_cfg_reads, 0)
        self.assertEqual(sim.e1, vc.E1_GPU)

    def test_negative_step(self):
        def fn(a):
            return "lost" if a.t_dip_us <= -90 else "under"
        sim = Sim(fn)
        with Rig(sim):
            rc, out = run_tool("vfi_edge", ARGS + ["--v-dips", "331", "--t-dip-start", "-86", "--step", "-1",
                                                   "--max-cells", "6"])
        tds = [int(l.split("t_dip=")[1].split(":")[0]) for l in out.splitlines() if l.startswith("cell ")]
        self.assertEqual(tds, [-86, -87, -88, -89, -90, -89])


class TraceTests(unittest.TestCase):
    def test_trace_needs_debug_build(self):
        sim = Sim()
        with Rig(sim), tempfile.TemporaryDirectory() as d:
            rc, out = run_tool("vfi_trace", ARGS + ["--out", os.path.join(d, "t.json"), "338:-60"])
        self.assertEqual(rc, 3, out)

    def test_trace_first_shot(self):
        sim = Sim(lambda a: "under", fw="clk=400 MHz  nvvdd=0.6880 V  sample_ns=240.0  last reset: x  "
                                         "fw=lab-psr1-debug")
        with Rig(sim), tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, "t.json")
            rc, out = run_tool("vfi_trace", ARGS + ["--out", f, "--shots", "3", "--mode", "first-shot",
                                                    "338:-60", "331:0:198:3"])
            self.assertEqual(oct(os.stat(f).st_mode & 0o777), "0o600")
            import json
            with open(f) as fh:
                cells = json.load(fh)["cells"]
        self.assertEqual(rc, 1, out)
        self.assertEqual(len(cells), 6)
        self.assertTrue(all(c["trough_mv"] is not None for c in cells))
        kinds = [e[0] for e in sim.events if e[0] in ("g", "r")]
        self.assertEqual(kinds.count("g"), 6)
        self.assertEqual(kinds.count("r"), 7)          # before every shot, plus the final park


class PreflightTests(unittest.TestCase):
    def test_brownout_card_is_not_read(self):
        sim = Sim()
        sim.crashed, sim.link = True, False
        with Rig(sim):
            rc, out = run_tool("vfi_preflight", ARGS)
        self.assertEqual(rc, 1, out)
        self.assertEqual(sim.cfg_reads, 0)
        self.assertIn("config space NOT read", out)

    def test_healthy_card(self):
        sim = Sim()
        with Rig(sim):
            rc, out = run_tool("vfi_preflight", ARGS)
        self.assertEqual(rc, 0, out)
        self.assertIn("PREFLIGHT OK", out)
        self.assertIn("differs from the upstream stock table", out)

    def test_held_rail_fails(self):
        sim = Sim()
        sim.e1 = vc.E1_PMBUS
        with Rig(sim):
            rc, out = run_tool("vfi_preflight", ARGS)
        self.assertEqual(rc, 1, out)


class SnapTests(unittest.TestCase):
    def _bar(self, d, fusectrl):
        import struct
        f = os.path.join(d, "bar0")
        with open(f, "wb") as fh:
            fh.truncate(0x1000000)
            for off, v in ((0x0, 0x170000A1), (0x820000, fusectrl), (0x820070, 0x55), (0x820084, 1),
                           (0x118234, 0xFF), (0x8204D8, 0x20C2)):
                fh.seek(off)
                fh.write(struct.pack("<I", v))
        return f

    def test_snapshot_reads_and_saves_private(self):
        with tempfile.TemporaryDirectory() as d:
            rc, out = run_tool("vfi_snap", ["--bdf", BDF, "--resource", self._bar(d, 0x00040000),
                                            "--outdir", os.path.join(d, "s")])
            self.assertEqual(rc, 0, out)
            self.assertIn("under/stock", out)
            self.assertIn("BOOT_GEN23_DIS=", out)
            files = os.listdir(os.path.join(d, "s"))
            import json
            with open(os.path.join(d, "s", files[0])) as jf:
                self.assertIn("OPT_PCIE_BOOT_GEN23_DIS", json.load(jf)["regs"])
            self.assertEqual(len(files), 1)
            self.assertEqual(os.stat(os.path.join(d, "s", files[0])).st_mode & 0o777, 0o600)

    def test_die_id_read_and_compare(self):
        import json
        import vfi_snap

        class Fuse:                                       # a fuse controller whose CMD_READ completes at once
            def __init__(self, rows):
                self.rows, self.addr, self.data, self.ctrl, self.writes = rows, 77, 0, 0x00040000, []

            def rd(self, off):
                return {vfi_snap.CTRL: self.ctrl, vfi_snap.ADDR: self.addr, vfi_snap.DATA: self.data}[off]

            def wr(self, off, val):
                self.writes.append((off, val))
                if off == vfi_snap.ADDR:
                    self.addr = val
                elif off == vfi_snap.CTRL and val == 1:
                    self.data = self.rows.get(self.addr, 0)

            def idle(self):
                return ((self.ctrl >> 16) & 31) == 4 and (self.ctrl & 3) == 0

        card = {8: 0xC0292E89, 9: 0xC0292E89, 12: 0x09001000, 13: 0x09001000}
        f = Fuse(card)
        got = vfi_snap.read_fuse_rows(f.rd, f.wr, f.idle, vfi_snap.DIE_ID_ROWS)
        self.assertEqual(got, {r: card.get(r, 0) for r in range(8, 16)})
        self.assertEqual(f.addr, 77)                                                   # FUSEADDR restored
        self.assertTrue(all(off in (vfi_snap.ADDR, vfi_snap.CTRL) for off, _ in f.writes))
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "dump.json")
            other = dict(card)
            other.update({8: 0xC048EE89, 9: 0xC048EE89})                               # another card, same GPC/SM
            with open(p, "w") as fh:
                json.dump({"ff_rows": {str(i): "%#010x" % other.get(i, 0) for i in range(512)}}, fh)
            want = vfi_snap.load_die_id(p)
            self.assertEqual([r for r in vfi_snap.DIE_ID_ROWS if got[r] != want[r]], [8, 9])
            with open(p, "w") as fh:                                                   # this tool's own --rows file
                json.dump({"rows": ["%#010x" % other.get(i, 0) for i in range(512)], "rows_match": True}, fh)
            self.assertEqual(vfi_snap.load_die_id(p), want)
            with open(p, "w") as fh:
                json.dump({"rows": ["%#010x" % other.get(i, 0) for i in range(512)], "rows_match": False}, fh)
            with self.assertRaises(vc.BenchStop):
                vfi_snap.load_die_id(p)
            with open(p, "w") as fh:
                json.dump({"ff_rows": {"0": "0x0"}}, fh)                                # not a full dump
            with self.assertRaises(vc.BenchStop):
                vfi_snap.load_die_id(p)
        self.assertEqual(vfi_snap.snapshot_rc({"die_id_match": False, "rows_match": True}), 5)
        self.assertEqual(vfi_snap.snapshot_rc({"die_id_match": True}), 0)
        self.assertEqual(vfi_snap.snapshot_rc({"die_id_error": "CMD_READ timeout at row 8"}), 1)

    def test_untrusted_row_read_is_a_failure(self):
        import vfi_snap
        self.assertEqual(vfi_snap.snapshot_rc({}), 0)                                   # no --rows
        self.assertEqual(vfi_snap.snapshot_rc({"rows_match": True, "state_unchanged_by_row_read": True}), 0)
        for bad in ({"rows_match": False, "state_unchanged_by_row_read": True},
                    {"rows_match": True, "state_unchanged_by_row_read": False},
                    {"rows_error": "CMD_READ timeout at row 3"}):
            with self.subTest(bad=bad):
                self.assertEqual(vfi_snap.snapshot_rc(bad), 1)

    def test_rail_check_before_config_read(self):
        # the README exports VFI_PORT and calls vfi_snap.py without --port; a low rail stops before config space
        from pathlib import Path
        for e1, label in ((vc.E1_GPU, "GPU asks for 301 mV"), (vc.E1_PMBUS, "rail at (E1=0xc2fa) 301 mV")):
            with self.subTest(e1=hex(e1)), tempfile.TemporaryDirectory() as d:
                sim = Sim()
                sim.e1 = e1
                sim.read_vout = lambda: 301
                saved, old = vc.sysfs, os.environ.get("VFI_PORT")
                vc.sysfs = lambda bdf: Path(d) / "no-device"             # a config read would fail with an I/O error
                os.environ["VFI_PORT"] = "/dev/fake"
                try:
                    with Rig(sim):
                        rc, out = run_tool("vfi_snap", ["--bdf", BDF, "--outdir", os.path.join(d, "s")])
                finally:
                    vc.sysfs = saved
                    if old is None:
                        os.environ.pop("VFI_PORT")
                    else:
                        os.environ["VFI_PORT"] = old
                self.assertEqual(rc, 3, out)
                self.assertIn(label + " (brown-out): config NOT read", out)

    def test_poisoned_stops_before_other_reads(self):
        for ctrl in (0xBADF510E, 0xBAD00100):
            with self.subTest(fusectrl=hex(ctrl)), tempfile.TemporaryDirectory() as d:
                rc, out = run_tool("vfi_snap", ["--bdf", BDF, "--resource", self._bar(d, ctrl),
                                                "--outdir", os.path.join(d, "s")])
                self.assertEqual(rc, 3, out)
                self.assertIn("poisoned", out)
                self.assertFalse(os.path.exists(os.path.join(d, "s")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
