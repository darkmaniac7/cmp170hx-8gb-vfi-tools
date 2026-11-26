#!/usr/bin/env python3
"""Build the synthetic test cards with ffcalc's own encoder and field map.

Run with python3 -I make_cases.py --ffcalc SRC --out DIR. Every card is built from ffcalc's sample
(samples/build_sample.py constants) by changing defective and disable masks, plus a realistic card for the
lab's published record words. Output: one JSON file per case.
"""
import argparse
import io
import json
import os
import sys

# Constants copied from ffcalc samples/build_sample.py (checked below against blog_card_example.json).
EFFECTIVE = {
    "fbio_disable": 0x000000, "fbpa_disable": 0xC0330C, "gpc_disable": 0x00,
    "tpc_gpc0_disable": 0xC0, "tpc_gpc1_disable": 0xC0, "tpc_gpc2_disable": 0xE0, "tpc_gpc3_disable": 0xE0,
    "tpc_gpc4_disable": 0xE0, "tpc_gpc5_disable": 0xF0, "tpc_gpc6_disable": 0xF0, "tpc_gpc7_disable": 0xF8,
    "pes_disable": 0x000000, "fbp_disable": 0x852, "rop_l2_disable": 0x000C40, "nvlink_disable": 0x7,
    "sys_pipe_disable": 0x2,
}
DEFECTIVE = {
    "fbio_defective": 0x000000, "fbpa_defective": 0xC03000, "gpc_defective": 0x00,
    "tpc_gpc0_defective": 0x80, "tpc_gpc1_defective": 0x40, "tpc_gpc2_defective": 0x20, "tpc_gpc3_defective": 0x10,
    "tpc_gpc4_defective": 0x08, "tpc_gpc5_defective": 0x04, "tpc_gpc6_defective": 0x02, "tpc_gpc7_defective": 0x01,
    "pes_defective": 0x000000, "fbp_defective": 0x840, "rop_l2_defective": 0x840, "nvlink_defective": 0x0,
    "sys_pipe_defective": 0x0,
}
PCIE_EFFECTIVE = {
    "disable_gen3_speed_bit1": 1, "disable_gen3_speed_bit9": 0, "pcie_magic_gen4_dis": 1,
    "pcie_boot_gen23_dis": 1, "pcie_boot_gen3_dis": 1,
}

# Stock chain-2 blocks as the lab read them (PCIe at stock), plus neighbours that must never change.
PCIE_STOCK = {(2, 37): 0x4184, (2, 38): 0x4184, (2, 39): 0x0782, (2, 46): 0xA000, (2, 47): 0x0059,
              (2, 49): 0x00E4, (2, 78): 0x1F3E}
PCIE_DONE = {(2, 39): 0x0582, (2, 47): 0x0051, (2, 49): 0x0024}
# Bits of chain-1 blocks that belong to no planned field, and unrelated factory records.
UNKNOWN_BITS = {(1, 5): 0x0007, (1, 8): 0xF800, (1, 11): 0x0405, (1, 17): 0x0A08, (1, 21): 0x0400,
                (1, 22): 0x1234, (1, 23): 0x0008, (0, 2): 0x0100, (3, 10): 0x00FF}

FF_MIN, FF_MAX = 222, 486


def pair(fbp):
    v = 0
    for n in range(12):
        if (fbp >> n) & 1:
            v |= 3 << (2 * n)
    return v


class Builder(object):
    def __init__(self, src):
        sys.path.insert(0, os.path.abspath(src))
        from ffcalc import ffrecord
        from ffcalc.optionmap import BY_KEY, set_bits
        self.encode = ffrecord.encode
        self.by_key = BY_KEY
        self.set_bits = set_bits
        self.src = src

    def blocks(self, effective, raw=None):
        blocks = {}
        for (c, b), v in (raw or {}).items():
            blocks.setdefault(c, {})[b] = v
        for key, value in effective.items():
            f = self.by_key[key]
            self.set_bits(blocks.setdefault(f.chain, {}), f.bit, f.width, value)
        return blocks

    def rows(self, blocks, history=(), filler=0, outside=False, start=FF_MIN):
        rows = {}
        row = start
        for c, b, v in history:
            rows[row] = self.encode(c, b, v)
            row += 1
        for i in range(filler):
            rows[row] = self.encode(0, 1, (i * 37 + 11) & 0xffff)
            row += 1
        for c in sorted(blocks):
            for b in sorted(blocks[c]):
                rows[row] = self.encode(c, b, blocks[c][b])
                row += 1
        if row - 1 > FF_MAX:
            raise SystemExit("case does not fit the FF rows")
        for r in range(FF_MIN, FF_MAX + 1):
            rows.setdefault(r, 0)
        if outside:
            seed = 0x2545F491
            for r in range(0, FF_MIN):
                seed = (seed * 1103515245 + 12345) & 0xffffffff
                rows[r] = seed if r % 3 else 0
            rows[487] = 0
            for r in range(488, 508):
                rows[r] = ((r * 0x01010101) & 0xffffffdf) | 0x20   # IFF op words carry bit 5
            for r in range(508, 512):
                rows[r] = 0
        return rows

    def dump(self, effective, defective, raw=None, sku="8gb", history=(), filler=0, outside=False, words=None,
             comment=""):
        bl = self.blocks(effective, raw)
        rows = self.rows(bl, history=history, filler=filler, outside=outside)
        ow = dict(effective)
        for k in list(ow):
            if self.by_key[k].category == "pcie":
                del ow[k]
        ow.update(defective)
        if words:
            ow.update(words)
        return {"sku": sku, "comment": comment,
                "ff_rows": dict(("%d" % r, "0x%08x" % v) for r, v in sorted(rows.items())),
                "option_words": dict((k, "0x%x" % v) for k, v in sorted(ow.items()))}


def vfi_snap(dump, effective, defective, status=None, pcie_regs=None, device="0x20c2"):
    """A vfi_snap.py --rows snapshot of the same card (register names as in tools/vfi_snap.py)."""
    status = status or {}
    e, d = effective, defective
    regs = {
        "PMC_BOOT_0": 0x170000a1, "GFW_BOOT_118234": 0xff, "FUSECTRL": 0xE0040000, "FUSEADDR": 0,
        "EN_SW_OVERRIDE": 0, "IFF_RECORD": 0x01fb01e8, "DEBUGCTRL": 0, "CRC_STATUS": 0x55, "EFP": 0,
        "R_82007c": 0, "DSOV": 1, "R_820088": 0, "PLM_e0": 0, "PLM_f4": 0, "PLM_f8": 0, "PLM_fc": 0,
        "WDATA_WR_SECURE": 0, "DEVIDA": 0x20c2, "SBFE": 1, "FPF_824314": 0,
        "GPC_DISABLE": e["gpc_disable"], "GPC_DEFECTIVE": d["gpc_defective"],
        "GPC_STATUS": status.get("gpc", e["gpc_disable"]),
        "PES_DISABLE": e["pes_disable"], "PES_DEFECTIVE": d["pes_defective"],
        "FBP_DISABLE": e["fbp_disable"], "FBP_R_820368": e["fbpa_disable"], "FBP_DEFECTIVE": d["fbp_defective"],
        "FBPA_DEFECTIVE": d["fbpa_defective"], "FBP_STATUS": status.get("fbp", e["fbp_disable"]),
        "FBIO_DISABLE": e["fbio_disable"], "FBIO_DEFECTIVE": d["fbio_defective"],
        "ROP_L2_DISABLE": e["rop_l2_disable"], "ROP_L2_DEFECTIVE": d["rop_l2_defective"],
        "FB_CFG1_9a0204": 0x02449000, "FB_LMR_100ce0": 0x20B,
        "OPT_DISABLE_GEN3_SPEED": 1, "OPT_PCIE_MAGIC_BITS_D": 0x16680000,
        "OPT_PCIE_BOOT_GEN23_DIS": 1, "OPT_PCIE_BOOT_GEN3_DIS": 1,
    }
    regs.update(pcie_regs or {})
    tpc_dis = [e["tpc_gpc%d_disable" % i] for i in range(8)]
    tpc_def = [d["tpc_gpc%d_defective" % i] for i in range(8)]
    tpc_st = list(status.get("tpc", tpc_dis))
    gst = regs["GPC_STATUS"]
    gdef = regs["GPC_DEFECTIVE"]
    rows = [int(dump["ff_rows"]["%d" % r], 0) for r in range(512)]
    return {
        "bdf": "0000:00:00.0", "identity": {"vendor": "0x10de", "device": device, "driver": None},
        "pci_command": "0x6", "label": "test", "utc": "2026-01-01T00:00:00+00:00",
        "regs": dict((k, "%#010x" % v) for k, v in regs.items()),
        "aliases": {}, "aliases_zero": 17,
        "per_gpc": {"tpc_disable": ["%#x" % v for v in tpc_dis], "tpc_defective": ["%#x" % v for v in tpc_def],
                    "tpc_reconfig": ["0x0"] * 8, "reconfig_override": ["0x0"] * 8,
                    "tpc_status": ["%#x" % v for v in tpc_st], "pes_status": ["0x0"] * 8},
        "sm_ceiling_nondefective": sum(2 * (8 - bin(tpc_def[i] & 0xFF).count("1")) for i in range(8)
                                       if not (gdef >> i) & 1),
        "sm_status_now": sum(2 * (8 - bin(tpc_st[i] & 0xFF).count("1")) for i in range(8) if not (gst >> i) & 1),
        "verdict": "under/stock (DSOV=1)", "warnings": [],
        "state_unchanged_by_row_read": True, "rows_match": True,
        "rows": ["%#010x" % v for v in rows], "rows_nonzero": sum(1 for v in rows if v),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ffcalc", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    B = Builder(a.ffcalc)
    os.makedirs(a.out, exist_ok=True)

    # Self-check: the copied constants rebuild ffcalc's own sample byte for byte.
    with io.open(os.path.join(a.ffcalc, "samples", "blog_card_example.json"), encoding="utf-8") as f:
        sample = json.load(f)
    rebuilt = B.rows(B.blocks(dict(EFFECTIVE, **PCIE_EFFECTIVE)))
    want = dict((int(k), int(v, 0)) for k, v in sample["ff_rows"].items())
    if rebuilt != want:
        raise SystemExit("constants do not rebuild ffcalc's sample")

    cases = []

    def add(name, kind, dump, desc, groups=None, **extra):
        c = {"name": name, "kind": kind, "description": desc, "dump": dump, "groups": groups or {}}
        c.update(extra)
        cases.append(c)

    def eff(**kw):
        e = dict(EFFECTIVE)
        e.update(PCIE_EFFECTIVE)
        e.update(kw)
        return e

    def defe(**kw):
        d = dict(DEFECTIVE)
        d.update(kw)
        return d

    def tpcs(prefix, vals):
        return dict(("tpc_gpc%d_%s" % (i, prefix), v) for i, v in enumerate(vals))

    # ---- the published lab case: realistic card, memory blocks as on the lab's cards ----
    pub_e = {
        "fbio_disable": 0xC0330C, "fbpa_disable": 0xC0330C, "rop_l2_disable": 0xC0330C, "fbp_disable": 0x852,
        "gpc_disable": 0x13, "pes_disable": 0x703F, "nvlink_disable": 0x7, "sys_pipe_disable": 0xFE,
    }
    pub_e.update(tpcs("disable", [0xFF, 0xFF, 0x01, 0x01, 0xFF, 0x01, 0x01, 0x01]))
    pub_d = {
        "fbio_defective": 0xC03000, "fbpa_defective": 0xC03000, "rop_l2_defective": 0xC03000,
        "fbp_defective": 0x840, "gpc_defective": 0x00, "pes_defective": 0x0, "nvlink_defective": 0x0,
        "sys_pipe_defective": 0x0,
    }
    pub_d.update(tpcs("defective", [0, 0, 0, 0, 0, 0x01, 0, 0]))
    pub_raw = dict(PCIE_STOCK)
    pub_raw.update(UNKNOWN_BITS)
    pub_hist = [(1, 20, 0x0000), (1, 19, 0x4291), (1, 8, 0xF8FF), (2, 39, 0x0702)]
    pub = B.dump(pub_e, pub_d, raw=pub_raw, history=pub_hist, outside=True,
                 comment="synthetic card with the lab's published old block values")
    published_expect = {
        "memory_words": [0x80070141, 0x06010181, 0x018001C1, 0x18000501, 0x420004C1],
        "memory_old": [0x9867, 0x6601, 0x0198, 0x1986, 0x4290],
        "pcie_words": [0x00510BC2, 0x058209C2, 0x00240C42],
    }
    add("C03-published-full", "parity", pub, "Lab's published case, all default groups (compute, memory, PCIe)",
        expect=published_expect,
        vfi_snap=vfi_snap(pub, pub_e, pub_d),
        vfi_snap_reconfig=vfi_snap(pub, pub_e, pub_d, status={"tpc": [0xFF, 0xFF, 0x01, 0x03, 0xFF, 0x01, 0x01, 0x01]}))
    add("C04-published-mem-pcie", "parity", pub, "Lab's published case, memory and PCIe only",
        groups={"compute": False}, expect=dict(published_expect, exact=True))

    # ---- cards built from ffcalc's sample by changing masks ----
    add("C01-sample", "parity", sample, "ffcalc's own sample (blog_card_example.json), default groups")
    add("C02-sample-all-groups", "parity", sample, "ffcalc sample with NVLink and SYS_PIPE ticked too",
        groups={"nvlink": True, "sys_pipe": True})
    add("C15-sample-memory-only", "parity", sample, "ffcalc sample, memory group only",
        groups={"compute": False, "pcie": False})

    e5 = eff(gpc_disable=0x85, pes_disable=0xE001C7, **tpcs("disable", [0xFF, 0xC0, 0xFF, 0xE0, 0xE0, 0xF0, 0xF0, 0xFF]))
    d5 = defe(gpc_defective=0x80, pes_defective=0xE00000,
              **tpcs("defective", [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x00]))
    add("C05-defective-gpc", "parity", B.dump(e5, d5), "GPC 7 marked defective (GPC disable 0x85 to 0x80)")

    raw_real = dict(PCIE_STOCK)
    raw_real.update(UNKNOWN_BITS)
    e6 = eff(gpc_disable=0xA8, pes_disable=0xE38E00, fbio_disable=0xC0330C, rop_l2_disable=0xC0330C,
             **tpcs("disable", [0x01, 0x00, 0x01, 0xFF, 0x01, 0xFF, 0x00, 0xFF]))
    for k in PCIE_EFFECTIVE:
        del e6[k]
    d6 = defe(fbio_defective=0xC03000, rop_l2_defective=0xC03000,
              **tpcs("defective", [0, 0, 0x01, 0, 0, 0, 0, 0x02]))
    add("C06-fbp-852-840", "parity", B.dump(e6, d6, raw=raw_real), "FBP 0x852 to 0x840 with a different compute sweep")

    def mem(cur, tgt, **kw):
        e = eff(fbp_disable=cur, fbio_disable=pair(cur), fbpa_disable=pair(cur), rop_l2_disable=pair(cur), **kw)
        for k in PCIE_EFFECTIVE:
            del e[k]
        d = defe(fbp_defective=tgt, fbio_defective=pair(tgt), fbpa_defective=pair(tgt), rop_l2_defective=pair(tgt))
        return e, d

    e7, d7 = mem(0x2D, 0x09)
    add("C07-fbp-target-09", "parity", B.dump(e7, d7, raw=raw_real), "FBP 0x2D to 0x09, masks 0xCF3 to 0xC3")
    e8, d8 = mem(0x2D, 0x24)
    add("C08-fbp-target-24", "parity", B.dump(e8, d8, raw=raw_real), "FBP 0x2D to 0x24, masks 0xCF3 to 0xC30")
    e9, d9 = mem(0x852, 0x852)
    add("C09-four-fbp-defective", "parity", B.dump(e9, d9, raw=raw_real), "Four FBPs marked defective: the 64 GB card")

    raw_done = dict(raw_real)
    raw_done.update(PCIE_DONE)
    e10, d10 = mem(0x852, 0x840)
    add("C10-pcie-already-cleared", "parity", B.dump(e10, d10, raw=raw_done), "PCIe fields already cleared")

    e11 = eff(nvlink_disable=0x7)
    d11 = defe(nvlink_defective=0x2)
    add("C11-nvlink-defective", "parity", B.dump(e11, d11), "NVLink defective mask 0x2, NVLink ticked",
        groups={"nvlink": True})

    add("C12-few-free-rows", "parity", B.dump(eff(), defe(), filler=232),
        "Sample masks with the FF rows filled to row 471: fewer than 16 blank rows remain")

    hist = [(1, 5, 0x9860), (2, 47, 0x0058), (1, 19, 0x4000), (1, 6, 0x0000), (1, 20, 0x1906), (2, 49, 0x00A4),
            (1, 5, 0x1867), (1, 12, 0x0000), (2, 39, 0x0780)]
    add("C13-superseded-history", "parity", B.dump(pub_e, pub_d, raw=pub_raw, history=hist, outside=True),
        "Published card with earlier superseded records for the same blocks (last record wins)")

    e14, d14 = mem(0x180, 0x180, gpc_disable=0x64, pes_disable=0x1F81C0)
    e14.update(tpcs("disable", [0x00, 0x00, 0xFF, 0x01, 0x00, 0xFF, 0xFF, 0x00]))
    d14.update(tpcs("defective", [0x01, 0, 0, 0, 0x02, 0, 0, 0]))
    add("C14-10gb", "parity", B.dump(e14, d14, raw=raw_real, sku="10gb"), "10 GB card (4 GiB per FBP)")

    e16, d16 = mem(0xC40, 0x840, gpc_disable=0x13)
    add("C16-shared-block-8", "parity", B.dump(e16, d16, raw=raw_real),
        "FBPA and GPC changes both land in chain 1 block 8")

    # ---- refusal cards (the page must refuse; ffcalc's behaviour is recorded by the harness) ----
    e, d = mem(0x852, 0x840)
    add("R07-fbpa-slices-of-defective-fbp", "refusal",
        B.dump(e, dict(d, fbpa_defective=0), raw=raw_real),
        "FBPA defective 0 while FBP 6 and 11 are defective: the FBPA target would enable slices of defective FBPs",
        refuse="belongs to FBP")
    add("R08-fbp-with-defective-slices", "refusal",
        B.dump(e, dict(d, fbp_defective=0x800), raw=raw_real),
        "FBP 6 would be enabled although its FBPA, FBIO and ROP_L2 slices are marked defective",
        refuse="marks its bits")
    bad5 = B.dump(e, d, raw=raw_real)
    bad5["ff_rows"]["230"] = "0x%08x" % (int(bad5["ff_rows"]["230"], 0) | 0x20)
    add("R09-bit5-inside-used-rows", "refusal", bad5, "Row 230 holds a word with bit 5 set", refuse="bit 5")
    bad5b = B.dump(e, d, raw=raw_real)
    bad5b["ff_rows"]["486"] = "0x00000021"
    add("R10-bit5-at-row-486", "refusal", bad5b, "Row 486 holds a word with bit 5 set", refuse="bit 5")
    add("R14-out-of-rows", "refusal", B.dump(eff(), defe(), filler=243),
        "FF rows used up to row 482: the plan does not fit", refuse="Ran out of free FF rows")
    mism = B.dump(e, d, raw=raw_real)
    mism["option_words"]["fbp_disable"] = "0x850"
    add("R17-live-mask-mismatch", "refusal", mism, "Live FBP mask 0x850 but the FF rows replay to 0x852",
        refuse="do not explain")
    e18, d18 = mem(0x852, 0x840, pes_disable=0)
    d18["pes_defective"] = 0x000100
    no_rec = B.dump(e18, d18, raw=raw_real)
    enc16 = "0x%08x" % B.encode(1, 16, 0)
    for k, v in list(no_rec["ff_rows"].items()):
        if v == enc16:
            no_rec["ff_rows"][k] = "0x%08x" % B.encode(0, 9, 0x5A5A)
    add("R18-no-record-for-block", "refusal", no_rec,
        "PES target needs chain 1 block 16, which no FF row holds", refuse="no FF row holds a record")
    miss = B.dump(e, d, raw=raw_real)
    del miss["option_words"]["fbp_defective"]
    add("R19-missing-defective-word", "refusal", miss, "fbp_defective missing from the dump", refuse="lacks fbp_defective")
    wide = B.dump(e, dict(d, gpc_defective=0x100), raw=raw_real)
    add("R24-defective-wider-than-field", "refusal", wide, "gpc_defective 0x100 does not fit the 8-bit field",
        refuse="wider than the 8-bit")

    for c in cases:
        with io.open(os.path.join(a.out, c["name"] + ".json"), "w", encoding="utf-8") as f:
            json.dump(c, f, indent=1, sort_keys=True)
    print("%d cases written to %s" % (len(cases), a.out))


if __name__ == "__main__":
    main()
