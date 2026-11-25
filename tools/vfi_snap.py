#!/usr/bin/env python3
"""Snapshot a CMP 170HX 8 GB card's fuse, gate and PCIe option registers to a private JSON file.

Default mode: BAR0 READS ONLY, no register or config-space writes. FUSECTRL is read first; on 0xBADFxxxx or
0xBAD0xxxx the tool stops without reading anything else.

--rows also reads the 512 main fuse rows twice through the fuse controller's READ command. That writes only
FUSEADDR (0x820004) and FUSECTRL = 1 (CMD_READ), then restores FUSEADDR. It never writes DEBUGCTRL (0x820060),
never selects RIR rows and never programs anything. Both passes must match.

--die-id DUMP reads fuse rows 8-15 (the die ID) once with the same CMD_READ and compares them with DUMP, the 512-row
dump a burn plan was made from (its ff_rows, or the rows of a --rows snapshot whose two passes matched). Cards with the
same GPC/SM/ceiling pass every other identity check; these rows tell them apart. Exit 5 when they differ. Only row
numbers are printed, never the values.

Run it on a healthy card (fresh boot, or right after vfi_park.py) or on a state held by vfi_hunt.py. With --port
the rail is checked over I2C first and config space is not touched if the GPU is in brown-out.

The output file is mode 0600. Fuse rows identify the card: keep dumps private.
"""
import argparse
import datetime
import json
import mmap
import os
import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vfi_common as vc  # noqa: E402

CTRL, ADDR, DATA = 0x820000, 0x820004, 0x820008
REGS = {
    "PMC_BOOT_0": 0x000000, "GFW_BOOT_118234": 0x118234,
    "FUSECTRL": 0x820000, "FUSEADDR": 0x820004, "EN_SW_OVERRIDE": 0x820040, "IFF_RECORD": 0x820050,
    "DEBUGCTRL": 0x820060, "CRC_STATUS": 0x820070, "EFP": 0x820078, "R_82007c": 0x82007C, "DSOV": 0x820084,
    "R_820088": 0x820088, "PLM_e0": 0x8200E0, "PLM_f4": 0x8200F4, "PLM_f8": 0x8200F8, "PLM_fc": 0x8200FC,
    "WDATA_WR_SECURE": 0x82048C, "DEVIDA": 0x8204D8, "SBFE": 0x821108, "FPF_824314": 0x824314,
    "GPC_DISABLE": 0x820350, "GPC_DEFECTIVE": 0x8205C4, "GPC_STATUS": 0x820C1C,
    "PES_DISABLE": 0x820690, "PES_DEFECTIVE": 0x820698,
    "FBP_DISABLE": 0x820364, "FBP_R_820368": 0x820368, "FBP_DEFECTIVE": 0x8205CC, "FBPA_DEFECTIVE": 0x8205D0,
    "FBP_STATUS": 0x820D38, "FBIO_DISABLE": 0x82036C, "FBIO_DEFECTIVE": 0x8205D4,
    "ROP_L2_DISABLE": 0x8202C4, "ROP_L2_DEFECTIVE": 0x8205E8, "FB_CFG1_9a0204": 0x9A0204, "FB_LMR_100ce0": 0x100CE0,
    "OPT_DISABLE_GEN3_SPEED": 0x820250, "OPT_PCIE_MAGIC_BITS_D": 0x820520,
    "OPT_PCIE_BOOT_GEN23_DIS": 0x82057C, "OPT_PCIE_BOOT_GEN3_DIS": 0x820580,
}
ALIASES = [0x820148, 0x820E20, 0x8207F4, 0x820158, 0x820324, 0x820434, 0x821108, 0x821058, 0x82074C,
           0x8206FC, 0x820644, 0x820640, 0x820410, 0x82063C, 0x820B98, 0x8205A8, 0x821064]
TPC_DEFECTIVE = [0x8205C8, 0x820508, 0x82050C, 0x820514, 0x820564, 0x8205AC, 0x820B84, 0x820B80]
TPC_RECONFIG = [0x820788, 0x82078C, 0x820790, 0x820794, 0x820798, 0x82079C, 0x820B94, 0x820B90]
DIE_ID_ROWS = tuple(range(8, 16))   # fuse rows that carry the die ID


def read_fuse_rows(rd, wr, idle, rows, timeout=0.2):
    """One CMD_READ per row; FUSEADDR is restored afterwards. RuntimeError on a latch failure, a poison or a timeout."""
    orig = rd(ADDR)
    got = {}
    try:
        for row in rows:
            wr(ADDR, row)
            if rd(ADDR) != row:
                raise RuntimeError(f"FUSEADDR did not latch row {row}")
            wr(CTRL, 1)
            t = time.monotonic() + timeout
            while not idle():
                c = rd(CTRL)
                if vc.is_poisoned(c):
                    raise RuntimeError(f"controller poisoned ({c:#010x}) at row {row}")
                if time.monotonic() > t:
                    raise RuntimeError(f"CMD_READ timeout at row {row}")
            got[row] = rd(DATA)
    finally:
        if idle():
            wr(ADDR, orig)
    return got


def load_die_id(path):
    """The die ID rows (8-15) of a 512-row dump, as ints: a dump's ff_rows, or the rows list this tool's --rows writes
    (only when its two passes matched)."""
    with open(path) as f:
        d = json.load(f)
    rows = d.get("ff_rows")
    if rows is None and isinstance(d.get("rows"), list):
        if d.get("rows_match") is not True:
            raise vc.BenchStop(f"{path}: the two passes of its row read differed; use a dump whose passes matched")
        rows = {str(i): v for i, v in enumerate(d["rows"])}
    rows = rows or {}
    want = {}
    for r in DIE_ID_ROWS:
        v = rows.get(str(r))
        if v is None:
            raise vc.BenchStop(f"{path} does not hold fuse row {r}: use the full 512-row dump the plan was made from")
        want[r] = int(v, 0) if isinstance(v, str) else int(v)
    return want


def snapshot_rc(out: dict) -> int:
    """5 when --die-id found a different card. 1 when a --rows or --die-id read cannot be trusted: it failed, the two
    passes differ, or the gate/status registers changed during the read. A plan must never be built from such a
    snapshot."""
    if out.get("die_id_match") is False:
        return 5
    bad = (out.get("rows_error") or out.get("die_id_error") or out.get("rows_match") is False
           or out.get("state_unchanged_by_row_read") is False)
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--bdf", type=vc.bdf_type, default=os.environ.get("VFI_BDF"), required=not os.environ.get("VFI_BDF"),
                    help="PCI address of the card (or set VFI_BDF)")
    ap.add_argument("--port", default=os.environ.get("VFI_PORT"),
                    help="Pico serial port: check the rail over I2C before any config read (or set VFI_PORT)")
    ap.add_argument("--rows", action="store_true", help="also read the 512 main fuse rows twice (CMD_READ only)")
    ap.add_argument("--die-id", metavar="DUMP", help="also read fuse rows 8-15 (the die ID, CMD_READ only) and compare "
                    "them with DUMP's (ff_rows, or a --rows snapshot); exit 5 when they differ (a different card)")
    ap.add_argument("--label", default="snap")
    ap.add_argument("--outdir", default="vfi-snaps")
    ap.add_argument("--allow-10gb", action="store_true", help="allow a 10 GB card (10de:2082), read-only use")
    ap.add_argument("--resource", help=argparse.SUPPRESS)   # offline tests: a file standing in for BAR0
    a = ap.parse_args()
    if a.resource:
        return run(a, {"vendor": "0x10de", "device": "0x20c2", "driver": None}, 0x0006, a.resource)

    devices = ("0x20c2", "0x2082") if a.allow_10gb else ("0x20c2",)
    ident = vc.check_card(a.bdf, devices)
    if a.port:
        with vc.open_card(a.port) as card:
            e1, mv = vc.rail(card)
        if mv < vc.HEALTHY_MV:   # whoever owns the rail (GPU, PMBus, unknown): a low rail is a brown-out
            who = "GPU asks for" if e1 == vc.E1_GPU else f"rail at (E1={e1:#06x})"
            raise vc.BenchStop(f"{who} {mv} mV (brown-out): config NOT read; run vfi_rescue.py")
        print(f"rail: E1={e1:#06x} READ_VOUT {mv} mV")
    p = vc.sysfs(a.bdf)
    cfg = (p / "config").read_bytes()[:8]
    if struct.unpack_from("<I", cfg, 0)[0] == vc.UNREADABLE:
        raise vc.BenchStop("config space reads 0xffffffff: the link is down (vfi_rescue.py)")
    cfg_cmd = struct.unpack_from("<H", cfg, 4)[0]
    if not cfg_cmd & 0x2:
        raise vc.BenchStop(f"memory decode is off (COMMAND bit 1); for a cold card: setpci -s {a.bdf} COMMAND=0x0002")
    return run(a, ident, cfg_cmd, p / "resource0")


def run(a, ident, cfg_cmd, resource) -> int:
    rw = a.rows or a.die_id
    fd = os.open(resource, (os.O_RDWR if rw else os.O_RDONLY) | os.O_SYNC)
    mm = mmap.mmap(fd, 0x1000000, mmap.MAP_SHARED, mmap.PROT_READ | (mmap.PROT_WRITE if rw else 0))
    os.close(fd)
    mv32 = memoryview(mm).cast("I")
    try:
        return snapshot(a, ident, cfg_cmd, mv32)
    finally:
        mv32.release()
        mm.close()


def snapshot(a, ident, cfg_cmd, mv32) -> int:
    def rd(off):
        return mv32[off // 4]

    def wr(off, val):
        if not (a.rows or a.die_id) or off not in (ADDR, CTRL) or (off == CTRL and val != 1):
            raise RuntimeError(f"write outside the CMD_READ allowlist: {off:#x}={val:#x}")
        mv32[off // 4] = val

    def idle():
        c = rd(CTRL)
        return ((c >> 16) & 31) == 4 and (c & 3) == 0

    ctrl = rd(CTRL)                      # first BAR0 read, always
    if ctrl == vc.UNREADABLE or vc.is_poisoned(ctrl):
        raise vc.BenchStop(f"FUSECTRL reads {ctrl:#010x}: poisoned controller or dead BAR0; nothing else read. "
                           "Park the card (vfi_park.py) before reading it.")
    out = {"bdf": a.bdf, "identity": ident, "pci_command": hex(cfg_cmd), "label": a.label,
           "utc": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    r = {k: rd(v) for k, v in REGS.items()}
    out["regs"] = {k: f"{v:#010x}" for k, v in r.items()}
    out["aliases"] = {f"{x:#08x}": f"{rd(x):#010x}" for x in ALIASES}
    out["aliases_zero"] = sum(1 for x in ALIASES if rd(x) == 0)
    g = {"tpc_disable": [rd(0x820760 + 4 * i) for i in range(8)], "tpc_defective": [rd(x) for x in TPC_DEFECTIVE],
         "tpc_reconfig": [rd(x) for x in TPC_RECONFIG], "reconfig_override": [rd(0x820A40 + 4 * i) for i in range(8)],
         "tpc_status": [rd(0x820C38 + 4 * i) for i in range(8)], "pes_status": [rd(0x820DBC + 4 * i) for i in range(8)]}
    out["per_gpc"] = {k: [f"{v:#x}" for v in vs] for k, vs in g.items()}
    gdef, gst = r["GPC_DEFECTIVE"], r["GPC_STATUS"]
    out["sm_ceiling_nondefective"] = sum(2 * (8 - bin(g["tpc_defective"][i] & 0xFF).count("1"))
                                         for i in range(8) if not (gdef >> i) & 1)
    out["sm_status_now"] = sum(2 * (8 - bin(g["tpc_status"][i] & 0xFF).count("1"))
                               for i in range(8) if not (gst >> i) & 1)
    gfw = r["GFW_BOOT_118234"] & 0xFF
    if r["DSOV"] == 1:
        verdict = "under/stock (DSOV=1)"
    elif r["DSOV"] == 0 and r["CRC_STATUS"] == 0x55 and r["PLM_fc"] == 0xFFFFFFFF:
        verdict = "GOLDILOCKS candidate (DSOV=0, CRC=0x55, PLM_fc=0xffffffff)"
    elif r["DSOV"] == 0 and r["CRC_STATUS"] == 0x55:
        verdict = f"hit, not burnable (DSOV=0, CRC=0x55, PLM_fc={r['PLM_fc']:#x})"
    elif r["DSOV"] == 0:
        verdict = f"over (DSOV=0, CRC={r['CRC_STATUS']:#x}, PLM_fc={r['PLM_fc']:#x})"
    else:
        verdict = f"unknown (DSOV={r['DSOV']:#x})"
    out["verdict"] = verdict
    warn = []
    if r["DEBUGCTRL"] != 0:
        warn.append("DEBUGCTRL nonzero: stop, never write it")
    if not idle():
        warn.append("fuse controller not idle")
    if r["DEVIDA"] & 0xFFFF not in (0x20C2, 0x2082):
        warn.append(f"DEVIDA={r['DEVIDA']:#x} (expected 0x20c2)")
    if gfw == 0x01:
        warn.append("GFW boot progress 0x01: do NOT glitch now, the card is mid-boot")
    out["warnings"] = warn

    rows = []
    if a.rows:
        if any(w.startswith(("DEBUGCTRL", "fuse controller")) for w in warn):
            raise vc.BenchStop("refusing the row read: " + "; ".join(warn))
        orig_addr = rd(ADDR)
        keys = ("EN_SW_OVERRIDE", "DSOV", "EFP", "SBFE", "GPC_STATUS", "FBP_STATUS", "DEBUGCTRL")
        before = {k: rd(REGS[k]) for k in keys}
        try:
            for _ in range(2):
                cur = []
                for row in range(512):
                    wr(ADDR, row)
                    if rd(ADDR) != row:
                        raise RuntimeError(f"FUSEADDR did not latch row {row}")
                    wr(CTRL, 1)
                    t = time.monotonic() + 0.2
                    while not idle():
                        c = rd(CTRL)
                        if vc.is_poisoned(c):
                            raise RuntimeError(f"controller poisoned ({c:#010x}) at row {row}")
                        if time.monotonic() > t:
                            raise RuntimeError(f"CMD_READ timeout at row {row}")
                    cur.append(rd(DATA))
                rows.append(cur)
        except RuntimeError as e:
            out["rows_error"] = str(e)
            warn.append("ROW READ FAILED: " + str(e))
        finally:
            if idle():
                wr(ADDR, orig_addr)
            else:
                warn.append("controller busy after the row read; FUSEADDR not restored")
        after = {k: rd(REGS[k]) for k in keys}
        out["state_unchanged_by_row_read"] = before == after
        if before != after:
            warn.append("gate/status registers changed during the row read")
        if len(rows) == 2:
            out["rows_match"] = rows[0] == rows[1]
            out["rows"] = [f"{v:#010x}" for v in rows[0]]
            out["rows_nonzero"] = sum(1 for v in rows[0] if v)
            if not out["rows_match"]:
                warn.append("ROW READS DIFFER between passes")

    if a.die_id:
        want = load_die_id(a.die_id)
        if any(w.startswith(("DEBUGCTRL", "fuse controller")) for w in warn):
            raise vc.BenchStop("refusing the die ID read: " + "; ".join(warn))
        try:
            got = read_fuse_rows(rd, wr, idle, DIE_ID_ROWS)
        except RuntimeError as e:
            out["die_id_error"] = str(e)
            warn.append("DIE ID READ FAILED: " + str(e))
        else:
            bad = [row for row in DIE_ID_ROWS if got[row] != want[row]]
            out["die_id_match"] = not bad
            out["die_id_rows_differing"] = bad
            if bad:
                warn.append(f"DIE ID MISMATCH: fuse rows {bad} differ from {a.die_id}: not the card that dump came from")

    fn = os.path.join(a.outdir, f"{datetime.datetime.now().strftime('%Y%m%dT%H%M%S')}-{a.label}.json")
    os.makedirs(a.outdir, mode=0o700, exist_ok=True)
    with os.fdopen(os.open(fn, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as f:
        json.dump(out, f, indent=1)
    s = out["regs"]
    print(f"{a.bdf} driver={ident['driver']} verdict: {verdict}")
    print(f"  DSOV={s['DSOV']} CRC={s['CRC_STATUS']} EFP={s['EFP']} SBFE={s['SBFE']} EN_SW={s['EN_SW_OVERRIDE']} "
          f"PLM_f8={s['PLM_f8']} PLM_fc={s['PLM_fc']} FUSECTRL={s['FUSECTRL']} GFW={gfw:#04x}")
    print(f"  GPC dis/def/st={s['GPC_DISABLE']}/{s['GPC_DEFECTIVE']}/{s['GPC_STATUS']} "
          f"FBP dis/def/st={s['FBP_DISABLE']}/{s['FBP_DEFECTIVE']}/{s['FBP_STATUS']} "
          f"SM now={out['sm_status_now']} ceiling={out['sm_ceiling_nondefective']} aliases_zero={out['aliases_zero']}/17")
    print(f"  PCIe: MAGIC_BITS_D={s['OPT_PCIE_MAGIC_BITS_D']} BOOT_GEN23_DIS={s['OPT_PCIE_BOOT_GEN23_DIS']} "
          f"BOOT_GEN3_DIS={s['OPT_PCIE_BOOT_GEN3_DIS']} DISABLE_GEN3_SPEED={s['OPT_DISABLE_GEN3_SPEED']}")
    if "rows_match" in out:
        print(f"  rows: 512 x2 match={out['rows_match']} nonzero={out['rows_nonzero']} "
              f"state_unchanged={out['state_unchanged_by_row_read']}")
    if "die_id_match" in out:
        print("  die ID (fuse rows 8-15): " + ("match" if out["die_id_match"]
                                                 else f"MISMATCH rows {out['die_id_rows_differing']}"))
    for w in warn:
        print("  WARN: " + w)
    print("  saved " + fn + " (0600; keep it private)")
    return snapshot_rc(out)


if __name__ == "__main__":
    sys.exit(vc.main_guard(main))
