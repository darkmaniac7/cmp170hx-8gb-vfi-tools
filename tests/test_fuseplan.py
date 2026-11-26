"""tools/fuseplan: the committed page is the build of its sources, it makes no network requests, and (with Node and an
ffcalc checkout in FFCALC) the parity, refusal and mutation suite passes."""
import os
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FP = os.path.join(ROOT, "tools", "fuseplan")


class FuseplanTest(unittest.TestCase):
    def copy(self):
        d = tempfile.mkdtemp(prefix="fuseplan-")
        self.addCleanup(shutil.rmtree, d, True)
        dst = os.path.join(d, "fuseplan")
        shutil.copytree(FP, dst)
        return dst

    def test_page_is_the_build_of_src(self):
        dst = self.copy()
        subprocess.run(["python3", "-I", os.path.join(dst, "build.py")], check=True, capture_output=True)
        with open(os.path.join(dst, "fuseplan.html"), "rb") as a, open(os.path.join(FP, "fuseplan.html"), "rb") as b:
            self.assertEqual(a.read(), b.read(), "fuseplan.html is stale: run tools/fuseplan/build.py")

    def test_page_makes_no_requests(self):
        with open(os.path.join(FP, "fuseplan.html"), encoding="utf-8") as f:
            page = f.read()
        self.assertIn("Content-Security-Policy", page)
        for pat in (r"<script[^>]+src=", r"<link[^>]+href=\"?https?:", r"\bfetch\(", r"XMLHttpRequest", r"WebSocket",
                    r"sendBeacon", r"<img[^>]+src=\"?https?:", r"@import"):
            self.assertIsNone(re.search(pat, page, re.I), pat)
        self.assertNotIn(chr(0x2014), page)
        self.assertNotIn(chr(0x2013), page)

    @unittest.skipUnless(shutil.which("node") and os.environ.get("FFCALC"), "needs node and FFCALC=<cmp170hx-ffcalc checkout>")
    def test_parity_refusal_and_mutation_suite(self):
        dst = self.copy()
        r = subprocess.run(["sh", os.path.join(dst, "tests", "run_all.sh"), os.environ["FFCALC"]], capture_output=True, text=True)
        if r.returncode == 3:
            self.skipTest("FFCALC is not at cmp170hx-ffcalc 4e089b5, the commit the parity cases are built on")
        self.assertEqual(r.returncode, 0, r.stdout[-3000:] + r.stderr[-2000:])
        self.assertRegex(r.stdout, r"TOTAL:\s+\d+ passed, 0 failed")
        self.assertRegex(r.stdout, r"mutants caught: (\d+) of \1")


if __name__ == "__main__":
    unittest.main()
