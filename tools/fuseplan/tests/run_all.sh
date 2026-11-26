#!/bin/sh
# Rebuild the page and the synthetic cards, then run the parity/refusal suite and the mutation check.
# Usage: tests/run_all.sh <path to a cmp170hx-ffcalc checkout>   (or FFCALC=<path> tests/run_all.sh)
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HERE")
FFCALC=${1:-${FFCALC:-}}
if [ -z "$FFCALC" ] || [ ! -f "$FFCALC/ffcalc/optionmap.py" ]; then
  echo "usage: tests/run_all.sh <path to a cmp170hx-ffcalc checkout> (or set FFCALC)"
  echo "  git clone https://github.com/sayhellotojungle/cmp170hx-ffcalc"
  exit 2
fi
python3 -I "$ROOT/build.py"
rm -rf "$HERE/cases"
python3 -I "$HERE/make_cases.py" --ffcalc "$FFCALC" --out "$HERE/cases" || {
  echo "the parity cases are built against cmp170hx-ffcalc 4e089b5: git -C $FFCALC checkout 4e089b5"; exit 3; }
node "$HERE/run_tests.js" --ffcalc "$FFCALC"
node "$HERE/mutants.js" --ffcalc "$FFCALC"
