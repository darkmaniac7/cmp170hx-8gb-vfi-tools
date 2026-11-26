#!/usr/bin/env python3
"""Reference runner: what upstream ffcalc itself answers for a case, as JSON on stdout.

Run with python3 -I. The ffcalc source folder is passed with --ffcalc (no environment, no cwd import).

  ref_runner.py --ffcalc SRC plan CASE.json        ffcalc analyze + plan (skip = groups not ticked), final replay
  ref_runner.py --ffcalc SRC simulate DUMP.json PLAN.json   ffcalc simulate on a plan (e.g. the page's export)
  ref_runner.py --ffcalc SRC rows ROWS.txt         ffcalc parse_rows + replay + decode_current
"""
import argparse
import io
import json
import os
import sys
import tempfile
import traceback

# ffcalc keys by the page's groups; anything not listed is never planned by the page.
GROUP_KEYS = {
    "compute": ["gpc_disable"] + ["tpc_gpc%d_disable" % i for i in range(8)] + ["pes_disable"],
    "memory": ["fbio_disable", "fbpa_disable", "fbp_disable", "rop_l2_disable"],
    "pcie": ["disable_gen3_speed_bit9", "pcie_magic_gen4_dis", "pcie_boot_gen23_dis", "pcie_boot_gen3_dis"],
    "nvlink": ["nvlink_disable"],
    "sys_pipe": ["sys_pipe_disable"],
}
DEFAULT_GROUPS = {"compute": True, "memory": True, "pcie": True, "nvlink": False, "sys_pipe": False}


def load_ffcalc(src):
    src = os.path.abspath(src)
    if not os.path.isfile(os.path.join(src, "ffcalc", "generate.py")):
        raise SystemExit("not an ffcalc source folder: %s" % src)
    sys.path.insert(0, src)
    import ffcalc  # noqa: F401
    from ffcalc import analyze, dump, ffrecord, ffrows, generate, optionmap, simulate
    return {"analyze": analyze, "dump": dump, "ffrecord": ffrecord, "ffrows": ffrows,
            "generate": generate, "optionmap": optionmap, "simulate": simulate}


def blocks_json(blocks):
    out = {}
    for chain in sorted(blocks):
        for blk in sorted(blocks[chain]):
            out["%d:%d" % (chain, blk)] = blocks[chain][blk]
    return out


def load_dump_obj(m, obj):
    """Write the dump to a temp file and load it with ffcalc's own load_dump."""
    fd, path = tempfile.mkstemp(suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f)
        return m["dump"].load_dump(path)
    finally:
        os.unlink(path)


def cmd_plan(m, case):
    out = {"load_error": None, "analysis": None, "analysis_error": None, "plan": None, "plan_error": None,
           "final_blocks": None, "skip": None}
    try:
        d = load_dump_obj(m, case["dump"])
    except Exception as e:  # noqa: BLE001
        out["load_error"] = "%s: %s" % (type(e).__name__, e)
        return out
    groups = dict(DEFAULT_GROUPS)
    groups.update(case.get("groups") or {})
    allowed = set()
    for g, on in groups.items():
        if on:
            allowed.update(GROUP_KEYS[g])
    skip = sorted(f.key for f in m["optionmap"].FIELDS if f.key not in allowed)
    out["skip"] = skip
    try:
        rep = m["analyze"].analyze(d)
        out["analysis"] = {
            "targets": rep["targets"], "sm_count": rep["sm_count"], "sm_per_gpc": rep["sm_per_gpc"],
            "usable_fbp": rep["usable_fbp"], "fb_gib": rep["fb_gib"], "fb_now_gib": rep["fb_now_gib"],
            "ff_rows_state": rep["ff_rows_state"], "ff_rows_used": rep["ff_rows_used"],
            "ff_rows_free": rep["ff_rows_free"], "warnings": rep["warnings"], "current": rep["current"],
        }
    except Exception as e:  # noqa: BLE001
        out["analysis_error"] = "%s: %s" % (type(e).__name__, e)
    try:
        p = m["generate"].plan(d, skip=skip)
        out["plan"] = {"burn": p["burn"], "warnings": p["warnings"], "targets": p["targets"]}
        rows = {r: v for r, v in d["ff_rows"].items() if m["optionmap"].FF_ROW_MIN <= r <= m["optionmap"].FF_ROW_MAX}
        for rec in p["burn"]:
            rows[rec["row"]] = int(rec["record"], 0)
        out["final_blocks"] = blocks_json(m["ffrecord"].replay(rows))
    except Exception as e:  # noqa: BLE001
        out["plan_error"] = {"type": type(e).__name__, "message": str(e)}
    return out


def cmd_simulate(m, dump_obj, plan_obj):
    d = load_dump_obj(m, dump_obj)
    res = m["simulate"].simulate(d, plan_obj)
    return {"errors": res["errors"], "warnings": res["warnings"], "pending": res["pending"],
            "changed": sorted(r["key"] for r in res["table"] if r["changed"])}


def cmd_rows(m, text):
    try:
        rows = m["ffrows"].parse_rows(text)
    except Exception as e:  # noqa: BLE001
        return {"error": "%s: %s" % (type(e).__name__, e)}
    d = {"sku": "8gb", "ff_rows": rows, "option_words": {}}
    state = m["ffrows"].coverage(d)[0]
    try:
        blocks = m["analyze"].replay_blocks(d)
        cur = m["analyze"].decode_current(blocks)
        return {"rows": {str(k): v for k, v in rows.items()}, "state": state, "blocks": blocks_json(blocks), "current": cur}
    except Exception as e:  # noqa: BLE001
        return {"rows": {str(k): v for k, v in rows.items()}, "state": state, "replay_error": "%s: %s" % (type(e).__name__, e)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ffcalc", required=True)
    ap.add_argument("cmd", choices=("plan", "simulate", "rows"))
    ap.add_argument("args", nargs="+")
    a = ap.parse_args()
    m = load_ffcalc(a.ffcalc)
    if a.cmd == "plan":
        with io.open(a.args[0], encoding="utf-8") as f:
            res = cmd_plan(m, json.load(f))
    elif a.cmd == "simulate":
        with io.open(a.args[0], encoding="utf-8") as f:
            dump_obj = json.load(f)
        with io.open(a.args[1], encoding="utf-8") as f:
            plan_obj = json.load(f)
        res = cmd_simulate(m, dump_obj, plan_obj)
    else:
        with io.open(a.args[0], encoding="utf-8") as f:
            res = cmd_rows(m, f.read())
    json.dump(res, sys.stdout, sort_keys=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        sys.exit(3)
