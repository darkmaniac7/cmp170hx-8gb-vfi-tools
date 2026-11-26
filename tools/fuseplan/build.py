#!/usr/bin/env python3
"""Inline src/core.js and src/ui.js into src/page.html and write fuseplan.html (one self-contained file)."""
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def read(p):
    with io.open(os.path.join(HERE, p), encoding="utf-8") as f:
        return f.read()


page = read("src/page.html")
core = read("src/core.js")
ui = read("src/ui.js")
for name, body in (("core", core), ("ui", ui)):
    if "</script" in body.lower():
        raise SystemExit("%s.js contains a closing script tag" % name)
assert page.count("/*@@CORE@@*/") == 1 and page.count("/*@@UI@@*/") == 1
out = page.replace("/*@@CORE@@*/", core.rstrip("\n")).replace("/*@@UI@@*/", ui.rstrip("\n"))
with io.open(os.path.join(HERE, "fuseplan.html"), "w", encoding="utf-8", newline="\n") as f:
    f.write(out)
print("wrote fuseplan.html (%d bytes)" % len(out.encode("utf-8")))
