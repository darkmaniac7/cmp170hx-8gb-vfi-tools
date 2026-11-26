# fuseplan: an offline fuse planner for the CMP 170HX

[`fuseplan.html`](fuseplan.html) is one self-contained page. Download it, open it in any browser, and paste or drop a
read of your own card. It shows what the card's fuses allow and, from a complete read, the exact FF record words a
burn would need. **It computes only: it writes nothing to any card and gives no burn commands.** The page loads no
scripts, fonts or data from anywhere, its content security policy blocks every network request, and your read never
leaves the browser.

What each field means and how each value is computed: [docs/FUSES.md](../../docs/FUSES.md).

## What it reads

- a `tools/vfi_snap.py --rows` snapshot (both row passes must match);
- an ffcalc card dump (`sku`, `option_words`, `ff_rows`);
- a plain rows file (`<row> <value>` per line): this shows the decoded FF records only, since the defect masks are not
  in the rows.

## What it shows

- SM count now and the SM ceiling, per GPC;
- FBPs active now and after, the 80 GB check (10 of 12 FBPs, FBIO, FBPA and ROP_L2 equal to the pair expansion of the
  FBP mask), and the 64 GB case;
- the four PCIe link-speed fields;
- from a complete read: one record per changed block, in the lab's order (compute with the GPC block last, memory with
  the FBP block last, then PCIe), each with its row, old and new block value, word and the bits it changes. Then a
  simulation of the whole plan, and an export in ffcalc's plan format so you can check it with
  `python3 -m ffcalc sim card.json plan.json`.

Compute, memory and PCIe are on by default. NVLink and SYS_PIPE are off by default: clearing those bits has not been
shown to turn the features on.

## What it refuses

It shows no records when any of these hold:

- the read is partial;
- the two row passes differ;
- a row in the FF pool has bit 5 set;
- a target would enable a unit marked defective, or a slice of a defective FBP;
- the FF rows do not reproduce the masks the card reports;
- a block it would change has no record to start from;
- the simulation does not land every target.

## How it differs from ffcalc

The field map and record format come from [cmp170hx-ffcalc](https://github.com/sayhellotojungle/cmp170hx-ffcalc), and
on everything else the two give the same records. The differences:

- The Gen3 speed target is chain 2 block 39 bit 9 only; ffcalc also clears bit 1.
- The page never plans the whole `PCIE_MAGIC_BITS_D` word or the device ID.
- It orders records the lab's way, and its refusals above are stricter.
- It ignores ffcalc's PCIe option words: ffcalc's ingest reads those registers at the chain bit position, while the
  registers hold the field in bit 0 (bit 25 for `PCIE_MAGIC_BITS_D`).

## Tested

- **Parity with ffcalc:** on 16 cards, ffcalc's sample, the lab's published case and synthetic cards built with
  ffcalc's own encoder.
- **Refusals:** 41 bad inputs.
- **Simulation tampering:** the simulation catches a tampered plan.
- **Mutation check:** 10 deliberate bugs, all caught.
- **The lab's own cards:** the page was run on the cold reads of the lab's seven burned 8 GB cards. Every compute and
  memory record matched, word for word, what was burned and verified after a cold boot. For PCIe it gave the values the
  cards ended up with after the lab's later corrections (the GEN23 record, and block 39 bit 9 only).

Run the suite with Node and Python and an ffcalc checkout at the commit the parity cases were built on:

```
git clone https://github.com/sayhellotojungle/cmp170hx-ffcalc
git -C cmp170hx-ffcalc checkout 4e089b5
tools/fuseplan/tests/run_all.sh cmp170hx-ffcalc
```

Newer ffcalc (from 2026-11-24) adds opt-in fields the page does not plan (`--mig`: the NVDEC, NVJPG and OFA bits;
`--a100`: the device ID and the whole `PCIE_MAGIC_BITS_D` word). The positions of every field the page plans are
unchanged in ffcalc master `3d157f2` (2026-11-25).

The page is built from `src/` by `build.py`; edit the sources, not `fuseplan.html`. Set `FUSEPLAN_PRIVATE_WORDS` (comma-separated) to
have the suite check that none of those words appear on the page.
