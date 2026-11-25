"""Offline tests for tools/pcie/: a fake sysfs tree with a BAR0 file, and fake setpci, nvidia-smi, journalctl and lspci on
PATH. No PCI device, driver or GPU is touched.

Run: python3 -I tests/test_pcie.py   (about 50 s: cmp-e1steps keeps its real pauses between writes)
"""
import json
import mmap
import os
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PCIE = os.path.join(HERE, "..", "tools", "pcie")
CARD, PORT = "0000:05:00.0", "0000:00:01.1"
BAR_SIZE = 0x824000
LINK_CONFIG_0 = 0x8C040

# The seven E1 registers before and after, as read on a burned card at Gen3 x16 (boot log of the lab's EPYC server).
E1_BEFORE = {0x88610: 0x00000001, 0x8841C: 0x20B40D00, 0x8C2C0: 0x060731B2, 0x88CE4: 0x0000003F,
             0x88CE0: 0x02100002, 0x8C1C0: 0x00130036, 0x8C040: 0x80044C00}
E1_AFTER = {0x88610: 0x00001001, 0x8841C: 0x20B42D00, 0x8C2C0: 0x060711B2, 0x88CE4: 0x00000014,
            0x88CE0: 0x02100006, 0x8C1C0: 0x00140036, 0x8C040: 0x80004C00}
DSOV, GEN23 = 0x820084, 0x82057C

FAKE_SETPCI = r'''#!/usr/bin/env python3
import json, os, struct, sys
args = sys.argv[1:]
assert args[0] == "-s", args
dev = args[1].lower()
if dev.count(":") == 1:
    dev = "0000:" + dev
with open(os.environ["FAKE_STATE"]) as f:
    st = json.load(f)
regs = st.setdefault(dev, {})
out = []
for a in args[2:]:
    if "=" in a:
        reg, val = a.split("=", 1)
        v, _, mask = val.partition(":")
        digits = {"w": 4, "l": 8, "b": 2}[reg.rsplit(".", 1)[1]]
        old = int(regs.get(reg, "0" * digits), 16)
        m = int(mask, 16) if mask else (1 << (4 * digits)) - 1
        regs[reg] = "%0*x" % (digits, (old & ~m) | (int(v, 16) & m))
        lc0 = "-"
        if os.environ.get("FAKE_BAR"):
            with open(os.environ["FAKE_BAR"], "rb") as b:
                b.seek(0x8C040)
                lc0 = "%08x" % struct.unpack("<I", b.read(4))[0]
        with open(os.environ["FAKE_LOG"], "a") as f:
            f.write("setpci %s %s lc0=%s\n" % (dev, a, lc0))
    else:
        dflt = "ffff" if a.endswith(".w") else "ffffffff"
        out.append(regs.get(a, dflt))
with open(os.environ["FAKE_STATE"], "w") as f:
    json.dump(st, f)
if out:
    print("\n".join(out))
'''

FAKE_NVSMI = r'''#!/usr/bin/env python3
import os, sys
a = " ".join(sys.argv[1:])
if "--query-compute-apps" in a:
    sys.stdout.write(os.environ.get("FAKE_APPS", ""))
elif "pci.bus_id,pci.device_id" in a:
    sys.stdout.write(os.environ.get("FAKE_GPUS", ""))
'''

FAKE_LSPCI = "#!/bin/sh\nprintf '\\t\\tLnkSta:\\tSpeed 8GT/s, Width x16\\n'\n"
FAKE_JOURNALCTL = "#!/bin/sh\nexit 0\n"


def _write(path, text, mode=0o755):
    with open(path, "w") as f:
        f.write(text)
    os.chmod(path, mode)


class Env:
    """A temporary root with fake tools first on PATH and a fake sysfs tree holding one card behind one port."""

    def __init__(self, device="0x20c2"):
        self.root = tempfile.mkdtemp(prefix="cmp-pcie-test-")
        self.bin = os.path.join(self.root, "bin")
        os.makedirs(self.bin)
        _write(os.path.join(self.bin, "setpci"), FAKE_SETPCI)
        _write(os.path.join(self.bin, "nvidia-smi"), FAKE_NVSMI)
        _write(os.path.join(self.bin, "lspci"), FAKE_LSPCI)
        _write(os.path.join(self.bin, "journalctl"), FAKE_JOURNALCTL)
        self.sys = os.path.join(self.root, "sys")
        real = os.path.join(self.sys, "devices", "pci0000:00", PORT, CARD)
        os.makedirs(real)
        os.makedirs(os.path.join(self.sys, "bus", "pci", "devices"))
        os.symlink(real, os.path.join(self.sys, "bus", "pci", "devices", CARD))
        _write(os.path.join(real, "device"), device + "\n", 0o644)
        self.bar = os.path.join(real, "resource0")
        with open(self.bar, "wb") as f:
            f.truncate(BAR_SIZE)
        self.state = os.path.join(self.root, "state.json")
        self.log = os.path.join(self.root, "calls.log")
        open(self.log, "w").close()
        self.set_cfg({CARD: {"CAP_EXP+12.w": "1103", "CAP_EXP+30.w": "0003", "ECAP_AER+04.l": "00000000",
                             "ECAP_AER+10.l": "00000000", "CAP_EXP+0c.l": "00457104", "CAP_EXP+2c.l": "0180001e"},
                      PORT: {"CAP_EXP+12.w": "f103", "CAP_EXP+30.w": "0003", "ECAP_AER+04.l": "00000000",
                             "ECAP_AER+10.l": "00000000", "CAP_EXP+2c.l": "0180001e"}})
        self.env = dict(os.environ, PATH=self.bin + os.pathsep + os.environ["PATH"], CMP_SYSFS=self.sys,
                        FAKE_STATE=self.state, FAKE_LOG=self.log, FAKE_BAR=self.bar, FAKE_APPS="",
                        FAKE_GPUS="00000000:05:00.0, 0x20C210DE\n")

    def set_cfg(self, cfg):
        with open(self.state, "w") as f:
            json.dump(cfg, f)

    def cfg(self):
        with open(self.state) as f:
            return json.load(f)

    def poke(self, regs):
        with open(self.bar, "r+b") as f:
            for off, val in regs.items():
                f.seek(off)
                f.write(struct.pack("<I", val))

    def peek(self, off):
        with open(self.bar, "rb") as f:
            f.seek(off)
            return struct.unpack("<I", f.read(4))[0]

    def calls(self):
        with open(self.log) as f:
            return f.read().splitlines()

    def run(self, argv, **extra):
        env = dict(self.env, **extra)
        return subprocess.run(argv, env=env, capture_output=True, text=True, timeout=120)

    def close(self):
        shutil.rmtree(self.root, ignore_errors=True)


def e1(env, **extra):
    return env.run([sys.executable, "-I", os.path.join(PCIE, "cmp-e1steps"), CARD], **extra)


class E1Steps(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.env.poke({**E1_BEFORE, DSOV: 1, GEN23: 0})

    def tearDown(self):
        self.env.close()

    def test_writes_the_seven_values_of_a_real_boot(self):
        r = e1(self.env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        for off, val in E1_AFTER.items():
            self.assertEqual(self.env.peek(off), val, hex(off))
        self.assertEqual(r.stdout.count("(stuck)"), 7)
        self.assertIn("done:", r.stdout)

    def test_hasd_is_set_on_port_and_card_before_link_config_0(self):
        r = e1(self.env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        hasd = [c for c in self.env.calls() if "CAP_EXP+30.w=0020:0020" in c]
        self.assertEqual([c.split()[1] for c in hasd], [PORT, CARD])
        for c in hasd:
            self.assertTrue(c.endswith("lc0=80044c00"), c)      # LINK_CONFIG_0 not yet written
        self.assertEqual(self.env.cfg()[CARD]["CAP_EXP+30.w"], "0023")
        self.assertEqual(self.env.cfg()[PORT]["CAP_EXP+30.w"], "0023")

    def test_refuses_a_card_whose_gen23_fuse_is_set(self):
        self.env.poke({GEN23: 1})
        r = e1(self.env)
        self.assertEqual(r.returncode, 1)
        self.assertIn("PCIE_BOOT_GEN23_DISABLE", r.stdout)
        for off, val in E1_BEFORE.items():
            self.assertEqual(self.env.peek(off), val, hex(off))
        self.assertEqual(self.env.calls(), [])

    def test_refuses_dsov_0_and_poisoned_reads(self):
        for dsov in (0, 0xBADF1701, 0xFFFFFFFF):
            self.env.poke({DSOV: dsov})
            r = e1(self.env)
            self.assertEqual(r.returncode, 1, hex(dsov))
            self.assertIn("DISABLE_SW_OVERRIDE", r.stdout)
            self.assertEqual(self.env.peek(0x88610), E1_BEFORE[0x88610])

    def test_refuses_another_device(self):
        env = Env(device="0x2082")
        try:
            env.poke({**E1_BEFORE, DSOV: 1, GEN23: 0})
            r = e1(env)
            self.assertEqual(r.returncode, 1)
            self.assertEqual(env.peek(0x88610), E1_BEFORE[0x88610])
        finally:
            env.close()

    def test_refuses_a_link_not_at_gen3(self):
        cfg = self.env.cfg()
        cfg[CARD]["CAP_EXP+12.w"] = "1102"
        self.env.set_cfg(cfg)
        r = e1(self.env)
        self.assertEqual(r.returncode, 1)
        self.assertIn("not Gen3", r.stdout)
        self.assertEqual(self.env.peek(0x88610), E1_BEFORE[0x88610])

    def test_refuses_a_card_with_a_compute_process(self):
        r = e1(self.env, FAKE_APPS="00000000:05:00.0\n")
        self.assertEqual(r.returncode, 1)
        self.assertIn("compute process", r.stdout)
        r = e1(self.env, FAKE_APPS="00000000:15:00.0\n")       # another card's process does not block
        self.assertNotIn("compute process", r.stdout)

    def test_stops_at_a_poisoned_register_read(self):
        self.env.poke({0x8C2C0: 0xBADF1020})
        r = e1(self.env)
        self.assertEqual(r.returncode, 2)
        self.assertIn("STOP before CYA_0", r.stdout)
        self.assertEqual(self.env.peek(0x88610), E1_AFTER[0x88610])
        self.assertEqual(self.env.peek(LINK_CONFIG_0), E1_BEFORE[LINK_CONFIG_0])

    def test_skips_registers_already_at_their_value(self):
        self.env.poke({0x88610: E1_AFTER[0x88610]})
        r = e1(self.env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("skip VSEC_HIER", r.stdout)


class Gen23Read(unittest.TestCase):
    def test_prints_the_shadow_register(self):
        env = Env()
        try:
            for val in (0, 1):
                env.poke({GEN23: val})
                r = env.run([sys.executable, "-I", os.path.join(PCIE, "cmp-gen23read"), CARD])
                self.assertEqual((r.returncode, r.stdout.strip()), (0, str(val)))
        finally:
            env.close()


FAKE_HELPERS = {
    "cmp-rmwalk": '#!/bin/bash\necho "rmwalk $1 settle=$SETTLE" >> "$FAKE_LOG"\nv=FAKE_RMWALK_RC_$1; exit ${!v:-0}\n',
    "cmp-gen23read": ('#!/usr/bin/env python3\nimport os, sys\n'
                      'print(os.environ.get("FAKE_GEN23_" + sys.argv[1][5:7], "1"))\n'),
    "cmp-e1steps": ('#!/usr/bin/env python3\nimport os, sys\nb = sys.argv[1][5:7]\n'
                    'open(os.environ["FAKE_LOG"], "a").write("e1 " + b + "\\n")\n'
                    'sys.exit(int(os.environ.get("FAKE_E1_RC_" + b, "0")))\n'),
    "cmp-gen4retrain": ('#!/bin/bash\nb=${1:5:2}\necho "g4 $b" >> "$FAKE_LOG"\n'
                        'v=FAKE_G4_RC_$b; exit ${!v:-0}\n'),
}


class Boot(unittest.TestCase):
    """cmp-pcie-boot with fake helpers: stage order, the GEN23 gate and the crash-loop guard."""

    def setUp(self):
        self.env = Env()
        self.helpers = os.path.join(self.env.root, "helpers")
        os.makedirs(self.helpers)
        for name, text in FAKE_HELPERS.items():
            _write(os.path.join(self.helpers, name), text)
        self.state = os.path.join(self.env.root, "boot-state")
        self.logs = os.path.join(self.env.root, "boot-logs")
        cfg = {}
        for bus, sta in (("05", "1103"), ("06", "1103"), ("07", "1103")):
            cfg["0000:%s:00.0" % bus] = {"CAP_EXP+12.w": sta}
        self.env.set_cfg(cfg)
        self.gpus = ("00000000:05:00.0, 0x20C210DE\n00000000:06:00.0, 0x20C210DE\n"
                     "00000000:07:00.0, 0x20C210DE\n00000000:08:00.0, 0x233010DE\n")

    def tearDown(self):
        self.env.close()

    def boot(self, **extra):
        env = dict(CMP_PCIE_STATE=self.state, CMP_PCIE_LOG=self.logs, CMP_PCIE_BIN=self.helpers,
                   FAKE_GPUS=self.gpus, FAKE_GEN23_05="0", FAKE_GEN23_06="1", FAKE_GEN23_07="0")
        env.update(extra)
        r = self.env.run(["bash", os.path.join(PCIE, "cmp-pcie-boot")], **env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return r.stdout, [c for c in self.env.calls() if not c.startswith("setpci")]

    def flags(self):
        return sorted(os.listdir(self.state))

    def test_walks_every_20c2_card_then_gen4_only_where_gen23_is_clear(self):
        out, calls = self.boot()
        self.assertEqual(calls, ["rmwalk 05 settle=30", "rmwalk 06 settle=30", "rmwalk 07 settle=30",
                                 "e1 05", "g4 05", "e1 07", "g4 07"])
        self.assertIn("card 05 Gen3 ok (Speed 8GT/s, Width x16)", out)
        self.assertIn("card 05 Gen4: e1 rc 0, retrain rc 0", out)
        self.assertNotIn("card 06 Gen4", out)
        self.assertEqual(self.flags(), [])

    def test_no_retrain_after_a_failed_e1(self):
        out, calls = self.boot(FAKE_E1_RC_05="3")
        self.assertNotIn("g4 05", calls)
        self.assertIn("card 05 Gen4: e1 rc 3, retrain rc -", out)
        self.assertIn("g4 07", calls)

    def test_a_leftover_marker_disables_that_card(self):
        os.makedirs(self.state)
        open(os.path.join(self.state, "inflight-06"), "w").close()
        open(os.path.join(self.state, "inflight-g4-07"), "w").close()
        out, calls = self.boot()
        self.assertIn("card 06: host went down during its Gen3 walk last boot; disabled", out)
        self.assertIn("card 07: host went down during its Gen4 step last boot; Gen4 disabled", out)
        self.assertNotIn("rmwalk 06 settle=30", calls)
        self.assertIn("rmwalk 07 settle=30", calls)
        self.assertNotIn("e1 07", calls)
        self.assertIn("e1 05", calls)
        self.assertEqual(self.flags(), ["disabled-06", "disabled-g4-07"])

    def test_a_card_lost_in_the_walk_is_disabled_and_the_service_stops(self):
        out, calls = self.boot(FAKE_RMWALK_RC_06="2")
        self.assertEqual(calls, ["rmwalk 05 settle=30", "rmwalk 06 settle=30"])
        self.assertIn("card 06 LOST during the walk (rc 2): disabled, stopping", out)
        self.assertEqual(self.flags(), ["disabled-06"])

    def test_off_flags(self):
        os.makedirs(self.state)
        open(os.path.join(self.state, "off-g4"), "w").close()
        out, calls = self.boot()
        self.assertEqual(calls, ["rmwalk 05 settle=30", "rmwalk 06 settle=30", "rmwalk 07 settle=30"])
        open(os.path.join(self.state, "off"), "w").close()
        open(self.env.log, "w").close()
        out, calls = self.boot()
        self.assertEqual(calls, [])
        self.assertIn("off flag set", out)

    def test_gen4_needs_gen3_first(self):
        cfg = self.env.cfg()
        cfg["0000:05:00.0"]["CAP_EXP+12.w"] = "1102"
        self.env.set_cfg(cfg)
        out, calls = self.boot(FAKE_RMWALK_RC_05="5")
        self.assertIn("card 05 walk failed (rc 5), card back at Gen2", out)
        self.assertIn("card 05 not at Gen3 (1102), Gen4 skipped", out)
        self.assertNotIn("e1 05", calls)


class Static(unittest.TestCase):
    def test_syntax(self):
        for name in sorted(os.listdir(PCIE)):
            path = os.path.join(PCIE, name)
            with open(path) as f:
                first = f.readline()
            if "bash" in first:
                r = subprocess.run(["bash", "-n", path], capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, name + r.stderr)
            elif "python3" in first:
                with open(path) as f:
                    compile(f.read(), path, "exec")

    def test_no_pack_into_on_bar0(self):
        scripts = 0
        for name in sorted(os.listdir(PCIE)):
            with open(os.path.join(PCIE, name)) as f:
                text = f.read()
            if not text.startswith("#!"):
                continue                                         # README.md, the unit file
            scripts += 1
            code = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
            self.assertNotIn("pack_into", code, name)
        self.assertEqual(scripts, 7)


if __name__ == "__main__":
    unittest.main()
