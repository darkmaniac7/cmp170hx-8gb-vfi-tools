# CMP 170HX fuse reference: every field, where it lives, and how to compute its value

This page lists every fuse field people burn, or ask about burning, on a CMP 170HX (GA100), with its register, its
place in the fuse chains and the rule that gives its value. It is written so that a person or an LLM can work out
each value from a card's own read, and check a plan before anything is burned.

> **Burns are permanent.** A wrong record can cost a feature, the whole PCIe link or the card. Compute every value
> from your own card's cold read, never from another card's plan or from the examples on this page. Check the plan
> with a simulator (cmp170hx-ffcalc `sim`, or the [fuse planner](../tools/fuseplan/fuseplan.html)) and have
> someone else review it. This repository reads and glitches; it never burns.

Field map and record format: [cmp170hx-ffcalc](https://github.com/sayhellotojungle/cmp170hx-ffcalc) (positions checked
against its master of 2026-11-25, `3d157f2`). Lab results:
[GUIDE.md](GUIDE.md) and the [results page](https://cmp.wiki/wiki/Voltage-glitch_unlock:_lab_results_and_fuse_findings).
Community records: [ALLSPARK.md](ALLSPARK.md) (Petri Krohn's A100 conversion guide) and repeaterdroid's
[MIG, NVDEC, NVJPG and OFA write-up](https://github.com/repeaterdroid/cmp170hx-mig-nvdec-nvjpg-ofa-unlock).

## How sure each entry is

| Mark | Meaning |
|---|---|
| **Lab** | Burned on the lab's 8 GB cards and read back after a cold boot (seven cards: A, B, C, E, F, G, H; the text names the cards when it matters) |
| **Upstream** | Burned on ffcalc's reference card and read back after a cold boot (docs/BURNING.md there) |
| **Community** | A read-back record from one community card (the Allspark guide, or repeaterdroid's MIG write-up); not repeated by the lab |
| **Contested** | Members disagree, or the reads disagree; do not burn on this page's word alone |

## Which fields for which goal

| Goal | Fields | Mark | Also needs |
|---|---|---|---|
| More SMs (70 to the card's ceiling) | `TPC_GPC0..7_DISABLE`, `PES_DISABLE`, `GPC_DISABLE` | Lab | nothing for the count; cmpunlocker's RECONFIG override for the last 4 SMs, or the RECONFIG record (Community) |
| 80 GB (10 of 12 FBPs) | `FBIO_DISABLE`, `FBPA_DISABLE`, `ROP_L2_DISABLE`, `FBP_DISABLE` | Lab | the 80 GB driver patch ([`driver/fb-geometry-80g.patch`](../driver/fb-geometry-80g.patch)); only cards with exactly 2 FBPs marked defective |
| PCIe Gen3 and Gen4 | `OPT_DISABLE_GEN3_SPEED`, `PCIE_MAGIC_BITS_D` bit 25, `OPT_PCIE_BOOT_GEN3_DIS`, `OPT_PCIE_BOOT_GEN23_DIS` | Lab | a full cold boot; on the lab's hosts the driver route in [`tools/pcie`](../tools/pcie/README.md) |
| NVLink | `NVLINK_DISABLE` | Upstream (the fuse reads 0 after the burn), Community (the feature) | a reference clock and bridges; clearing the fuse alone did not give NVLink in the lab's volatile test on a 10 GB card |
| MIG | `SYS_PIPE_DISABLE` | Upstream (the fuse), Community (the feature: 8-way MIG on the stock 615 driver on one card) | gpu-unlock or cmpunlocker for the rest of the card; not tested by the lab |
| NVDEC, NVJPG, OFA | `NVDEC_DISABLE` (chain 1 bits 139 to 143) and the NVJPG/OFA pair (chain 1 bits 146 and 371) | Community (5 NVDECs, NVJPG and OFA working on one card); ffcalc plans them only with `--mig` | not tested by the lab |
| FP and integer speed selects | chain 2 blocks 78 and 79 | Community | not tested by the lab |
| A100 identity | `PCIE_DEVIDA` (and `DEVIDB` for vGPU) | Community | an A100 VBIOS flashed right after: the card will not POST on the CMP VBIOS with an A100 ID; a board with large (64-bit) BAR support |
| ECC, row remapper, FP64, vGPU, OpenGL, TTU | column fuses in rows 2 to 49 | Contested | not FF records at all; see [Column fuses](#column-fuses-not-ff-records) |

## How the fuses work

**The array.** GA100 has 512 fuse rows of 32 bits. A fuse burns from 0 to 1 once and never goes back.

| Rows | What they hold |
|---|---|
| 0 to 221 | regular fuses: the column fuses (the first 90 or so rows, per Allspark), the gate fuses (DSOV is bit 5 of rows 0 and 1), the defect masks |
| 222 to 486 | the FF (fuseless fuse) pool: the factory's records, then blank rows. ffcalc plans in 222 to 486 |
| 487 | the last row before the stock IFF window; ffcalc does not plan it |
| 488 to 507 | the IFF window on stock cards (`IFF_RECORD` `0x820050` reads `0x01FB01E8`: start `0x1E8` = 488, last `0x1FB` = 507). Read your own card's `IFF_RECORD`: the start can differ |
| 508 to 511 | above the stock IFF window |

The 16 RIR records are not in these rows: they sit in a separate macro, selected by `DEBUGCTRL` (`0x820060`) bit 1 (RWL).

**Option registers.** The card's features are option registers (`NV_FUSE_OPT_*`) in the BAR0 fuse block, `0x820000` to `0x820FFF`.
Each is a slice of a fuse **chain**, a long bit string that the boot assembles from the fuses. Chain 1 holds the
floorsweep (compute and memory), chain 2 the PCIe and identity fields. A chain is cut into 16-bit **blocks**: chain
bit `n` sits in block `n // 16`, at bit `n % 16`.

**FF records.** An FF record is one fuse row that replaces one whole block:

```
word = data[31:16] | block[15:6] | chain[4:0]          bit 5 must be 0
data = (word >> 16) & 0xFFFF
block = (word >> 6) & 0x3FF
chain = word & 0x1F
```

The boot reads the FF pool from row 222 upward, and **the last record for a (chain, block) wins**.

**Bit 5 ends the pool.** A word with bit 5 set is an IFF word: inside the FF pool it ends the pool at that row, and every
later FF record and the stock IFF window are ignored. Three members' cards were stuck at GFW `0x01` after a `0xDEADBEEF`
"probe" word (bit 5 set) burned at row 480 before their real records. Never burn a test, probe or canary word. The fix
reported for those cards is to burn that row to all ones (`0xFFFFFFFF`), which the boot skips; see
[Unlock without bricking](https://cmp.wiki/wiki/Unlock_without_bricking). The NVIDIA
factory already wrote records there: the CMP limits are themselves FF records (on the lab's cards the PCIe block 49
reads `0x00E4` from a factory record). So a new record can set bits back to 0 by replacing the block. That is why
the unlock works, even though each fuse only goes 0 to 1.

**What you cannot do.** While the gate is closed, BAR0 writes to the option registers are ignored, and with it open
they only last until a reset. FF rows only take a burn once the gate is open: DSOV (`0x820084` bit 0) reads 0, `DEBUGCTRL`
(`0x820060`) reads 0 (RWL clear, so the main array is selected), and SBFE (`0x821108`) is cleared. With RWL set, the row
address is taken mod 8 and lands in the RIR macro. On the 8 GB card only the voltage glitch opens the gate, and a cold
boot closes it again. On the 10 GB card an RIR burn opens it ([RIR fuse burn](https://cmp.wiki/wiki/RIR_fuse_burn)).

**Three words per field.** For most floorsweep fields the card has three registers:

| Word | Example (FBP) | Meaning |
|---|---|---|
| fused (`OPT_*_DISABLE`) | `0x820364` | what the fuses, FF records included, disable |
| defective (`OPT_*_DEFECTIVE`) | `0x8205CC` | units that failed factory test; **never enable these** |
| status | `0x820D38` | what is off at runtime (fused plus firmware masks) |

A unit that is disabled but not defective is good silicon the CMP limits switched off. That is everything there is
to gain. Plan from the fused words and the FF replay. The status words add the firmware's runtime masks (RECONFIG), so
they can show more units off than the fuses do, and some tools print only one of the three.

## The rule for every floorsweep target

```
target = DEFECTIVE              (clear exactly the units not marked defective)
check:  target & DEFECTIVE == DEFECTIVE      (no defective unit enabled)
```

Run it field by field: `TPC_GPCn`, `PES`, `GPC`, `FBIO`, `FBPA`, `ROP_L2` and `FBP`. This is ffcalc's rule and the
lab's. If a target would enable a defective unit, stop: "If it is marked as defective, do not enable it"
(petrikrohn_26497); enabling defective FBPs is the biggest brick risk the community has named.

Two more checks before you trust the targets:

- **No live GPC without live TPCs.** Every GPC left on must keep at least one TPC on.
- **Memory follows the pair rule** ([below](#chain-1-memory-and-the-80-gb-layout)). If a defective FBIO, FBPA or ROP_L2
  bit falls inside an FBP you want on, keep that whole FBP off. If the four masks cannot be made to agree, stop.

ffcalc's own plan differs from the lab's in two ways: it also clears chain 2 block 39 bit 1, and it orders records by
block. The lab checked plans with ffcalc's `sim` but burned its own order, without bit 1.

## Chain 1: compute

8 GPCs, each with 8 TPCs of 2 SMs: 128 SMs on a complete die.

| Field | Fused | Defective | Status | Chain 1 bits | Blocks | Bits per unit |
|---|---|---|---|---|---|---|
| `GPC_DISABLE` | `0x820350` | `0x8205C4` | `0x820C1C` | 131 to 138 | 8 (bits 3 to 10) | 1 per GPC |
| `TPC_GPC0_DISABLE` | `0x820760` | `0x8205C8` | `0x820C38` | 187 to 194 | 11 (bits 11 to 15), 12 (0 to 2) | 1 per TPC |
| `TPC_GPC1_DISABLE` | `0x820764` | `0x820508` | `0x820C3C` | 195 to 202 | 12 (3 to 10) | |
| `TPC_GPC2_DISABLE` | `0x820768` | `0x82050C` | `0x820C40` | 203 to 210 | 12 (11 to 15), 13 (0 to 2) | |
| `TPC_GPC3_DISABLE` | `0x82076C` | `0x820514` | `0x820C44` | 211 to 218 | 13 (3 to 10) | |
| `TPC_GPC4_DISABLE` | `0x820770` | `0x820564` | `0x820C48` | 219 to 226 | 13 (11 to 15), 14 (0 to 2) | |
| `TPC_GPC5_DISABLE` | `0x820774` | `0x8205AC` | `0x820C4C` | 227 to 234 | 14 (3 to 10) | |
| `TPC_GPC6_DISABLE` | `0x820778` | `0x820B84` | `0x820C50` | 235 to 242 | 14 (11 to 15), 15 (0 to 2) | |
| `TPC_GPC7_DISABLE` | `0x82077C` | `0x820B80` | `0x820C54` | 243 to 250 | 15 (3 to 10) | |
| `PES_DISABLE` | `0x820690` | `0x820698` | none | 251 to 274 | 15 (11 to 15), 16, 17 (0 to 2) | 3 per GPC |

Mark: Lab. The lab's cards took 6 to 8 compute records (A and E 6; B, C, F and G 7; H 8).

**SM count.**

```
SMs   = sum over GPCs g not set in GPC_DISABLE of 2 * (8 - popcount(TPC_GPCg_DISABLE & 0xFF))
ceiling = the same sum with GPC_DEFECTIVE and TPC_GPCg_DEFECTIVE
```

A stock 8 GB card reads 70 SMs (74 under cmpunlocker's override). The seven burned cards had ceilings of 110 to 126
(card D, not burned, reads 128). A whole defective GPC costs 16 SMs (card F, GPC 7 defective: ceiling 112).

**The last 4 SMs.** Three separate facts:

- Lab: after a burn every lab card reported its ceiling minus 4 (A and G: 122 against a ceiling of 126), and
  cmpunlocker's RECONFIG override gives the 4 back under its driver (122 to 126). Two TPCs stay off through a RECONFIG
  mask, not through these fields.
- Community: the Allspark card cleared its RECONFIG pair with a chain 1 block 26 record (`0x00000681`, "GPC3+GPC4
  RECONFIG to 0, SM 104 to 108"). Which GPCs hold the pair differs by card; the lab has not burned block 26.
- Upstream: on ffcalc's reference card `TPC_GPC3` and `TPC_GPC6` read 1 in the status layer and 0 in the fused layer.
  That is a runtime mask and is normal: do not burn more bits into those TPC fields.

**Worked example (illustrative numbers, not a real card).** `GPC_DISABLE` `0xE0` (GPCs 5, 6, 7 off), `GPC_DEFECTIVE`
`0x80` (GPC 7), `TPC_GPC2_DEFECTIVE` `0x04` (TPC 2), every other defective word 0. Targets: `GPC_DISABLE` `0x80`,
`TPC_GPC2_DISABLE` `0x04`, every other TPC field `0x00`, PES as its defective word. Ceiling: 7 GPCs x 8 TPCs = 56,
minus 1 defective TPC = 55 TPCs = 110 SMs. On the lab's cards the count after a burn was the ceiling minus 4, so expect
106 until the RECONFIG pair comes back.

**Order.** The GPC field shares block 8 with the top 3 bits of `FBPA_DISABLE` (block bits 0 to 2: FBPA bit 21 of FBP
10 and both bits of FBP 11) and, per the Allspark card, the NVDEC disables (bits 11 to 15). Burn the TPC and PES records first and the block 8 record last, so a cut
burn never leaves an enabled GPC with no live TPCs. The block 8 word must carry every other bit of block 8 unchanged.

## Chain 1: memory and the 80 GB layout

12 FBPs (frame buffer partitions). On the 8 GB card each active FBP gives 8 GiB: 8 active is the stock 64 GB
layout, 10 active is 80 GB. On the 10 GB card each FBP gives 4 GiB.

| Field | Fused | Defective | Status | Chain 1 bits | Blocks | Width |
|---|---|---|---|---|---|---|
| `FBIO_DISABLE` | `0x82036C` | `0x8205D4` | `0x820C14` | 83 to 106 | 5 (bits 3 to 15), 6 (0 to 10) | 24, 2 per FBP |
| `FBPA_DISABLE` | `0x820368` | `0x8205D0` | `0x820C18` | 107 to 130 | 6 (11 to 15), 7, 8 (0 to 2) | 24, 2 per FBP |
| `FBP_DISABLE` | `0x820364` | `0x8205CC` | `0x820D38` | 307 to 318 | 19 (bits 3 to 14) | 12, 1 per FBP |
| `ROP_L2_DISABLE` | `0x8202C4` | `0x8205E8` | none | 319 to 342 | 19 (bit 15), 20, 21 (0 to 6) | 24, 2 per FBP |

Mark: Lab. Which blocks change depends on which FBPs come back. On cards A, B, C, F and G (FBPs 1 and 4 back) it was
five records: FBIO (block 5), FBPA (blocks 6 and 7), ROP_L2 (block 20) and FBP (block 19) last. Cards E and H brought
back other FBPs and needed other blocks and words.

**The pair rule.** FBP `n` owns bits `2n` and `2n+1` of FBIO, FBPA and ROP_L2. All four masks must agree:

```
pair(m) = OR over bits n set in m of (3 << 2n)
FBIO_target = FBPA_target = ROP_L2_target = pair(FBP_target)
```

| Card | FBP disable before | after (= FBP defective) | FBIO / FBPA / ROP_L2 after | Memory |
|---|---|---|---|---|
| A, B, C, F, G | `0x852` (FBPs 1, 4, 6, 11) | `0x840` (6, 11) | `0xC03000` | 81920 MiB under the 80 GB driver |
| E | card-specific | `0x009` (0, 3) | `0x0000C3` (by the pair rule) | 81920 MiB |
| H | card-specific | `0x024` (2, 5) | `0x000C30` | 81920 MiB |

**64 GB "duds".** A card with 4 FBPs marked defective cannot reach 80 GB: there are no gated FBPs to win back. It can
still gain SMs and PCIe. No card has reached 96 GB (all 12 FBPs): every card the lab read has two FBPs marked defective.
The Allspark guide puts the common FBP 6 and 11 pattern down to an unpopulated HBM site; cards E and H show other FBPs
can be the defective ones.

**The driver.** Mainstream cmpunlocker programs the 64 GiB geometry on every 8 GB card, burned or not.
`driver/fb-geometry-80g.patch` gives 80 GiB only to a card that reports exactly 10 of 12 FBPs active with FBPA, FBIO
and ROP_L2 equal to the pair expansion of its FBP mask. Never hard-code a mask: the lab's seven cards show three
(`0x840`, `0x024`, `0x009`).

**Worked example: the lab's memory records** (cards A, B, C, F and G; cards E and H needed their own). Stock
FBP `0x852`, FBIO = FBPA = ROP_L2 = `pair(0x852)` = `0xC0330C`; targets `0x840` and `0xC03000`.

| Block | Holds | Old (as read) | New | Word |
|---|---|---|---|---|
| 5 | FBIO bits 0 to 12 in block bits 3 to 15; bits 0 to 2 not mapped, kept | `0x9867` | `0x8007` | `0x80070141` |
| 6 | FBIO bits 13 to 23, FBPA bits 0 to 4 | `0x6601` | `0x0601` | `0x06010181` |
| 7 | FBPA bits 5 to 20 | `0x0198` | `0x0180` | `0x018001C1` |
| 20 | ROP_L2 bits 1 to 16 | `0x1986` | `0x1800` | `0x18000501` |
| 19 | FBP bits 0 to 11 in block bits 3 to 14; ROP_L2 bit 0 in bit 15 | `0x4290` | `0x4200` | `0x420004C1` |

Blocks 8 and 21 need no record here. Block 8 holds FBPA bits 21 to 23 (FBPs 10 and 11) and block 21 holds ROP_L2 bits
17 to 23 (FBPs 8 to 11); none of those FBPs changes on these cards.

## Chain 2: PCIe link speed

| Field (register) | Chain 2 location | Stock | Target | Mark |
|---|---|---|---|---|
| `OPT_DISABLE_GEN3_SPEED` (`0x820250`) | block 39 bit 9 (chain bit 633) | 1 | 0 | Lab |
| `PCIE_MAGIC_BITS_D` (`0x820520`) bit 25, the Gen4 disable | block 47 bit 3 (chain bit 755) | `0x16680000` | `0x14680000` | Lab |
| `OPT_PCIE_BOOT_GEN3_DIS` (`0x820580`) | block 49 bit 7 (chain bit 791) | 1 | 0 | Lab |
| `OPT_PCIE_BOOT_GEN23_DIS` (`0x82057C`) | block 49 bit 6 (chain bit 790) | 1 | 0 | Lab |

The records on the lab's cards (every other bit of each block kept):

| Block | Old | New | Word | Clears |
|---|---|---|---|---|
| 39 | `0x0782` | `0x0582` | `0x058209C2` | Gen3 speed (bit 9) |
| 47 | `0x0059` | `0x0051` | `0x00510BC2` | MAGIC_D bit 25 (block bit 3) |
| 49 | `0x00E4` | `0x0024` | `0x00240C42` | BOOT_GEN3 (bit 7) and BOOT_GEN23 (bit 6) in one record |

- **Burn all four.** The lab's first burns cleared BOOT_GEN3 alone (block 49 to `0x0064`, word `0x00640C42`) and
  left BOOT_GEN23 set. Those five cards each needed a second glitch session for one more record: block 49 again, the
  word `0x00240C42`, burned in a later row (the last record wins). With GEN23 still set a cold card advertises 2.5 GT/s
  and the driver caps it at Gen2. With all four clear the cold card advertises 16 GT/s x16.
- **Gen3 speed is bit 9, not bit 1.** ffcalc burns block 39 bits 1 and 9 by default, as upstream had not settled
  which; on the lab's cards bit 9 alone does it ("bit 1 does nothing for it"). The lab's word and the Allspark
  card's word are the same, `0x058209C2`, and both keep block 39 bit 1 as it was read (set).
- **MAGIC_D layout.** The register is chain 2 bits 730 to 761: register bit `k` is chain bit `730 + k`, so bits 0
  to 5 are block 45 bits 10 to 15, bits 6 to 21 are block 46 and bits 22 to 31 are block 47 bits 0 to 9. Stock
  `0x16680000` = block 47 `0x0059`, block 46 `0xA000`, block 45 bits 10 to 15 zero. The only target is bit 25: never
  plan the whole word for a CMP identity. ffcalc's `--a100` rewrites it to the community A100 value `0x00200000`
  together with the device ID; the lab never burned it.
- Results on the lab's cards: cold `LnkCap` 16 GT/s x16 on all seven; Gen4 x16 at every boot on six of them on the
  lab's EPYC server (the seventh sits in a marginal slot and runs at Gen3 x16). See [GUIDE.md section 4.4](GUIDE.md).

## Chain 2: identity (Community)

| Field | Register | Chain 2 bits | Blocks | Stock |
|---|---|---|---|---|
| `PCIE_DEVIDA` | `0x8204D8` | 593 to 608 | 37 (bits 1 to 15), 38 (bit 0) | `0x20C2` (8 GB), `0x2082` (10 GB) |
| `PCIE_DEVIDB` | `0x82056C` | 609 to 624 | 38 (bits 1 to 15), 39 (bit 0) | not read by the lab |

The device ID sits one bit up: DEVIDA bit `k` is block 37 bit `k+1` for `k` 0 to 14, and bit 15 is block 38 bit 0.
Block 37 bit 0 is not part of DEVIDA: keep it as read (ffcalc puts each ID's bit 15 in bit 0 of the next block, 0 for both the CMP and the A100 ID). The Allspark card's record `0x416A0942` is block 37 data
`0x416A`; its bit 0 is 0 and `0x416A >> 1` = `0x20B5` (A100 80GB; the guide gives `0x20F1` for A100 40GB). Per that
guide, set DEVIDA to match the VBIOS you will flash, and DEVIDB only for vGPU, after the flash. With an A100 ID the
card will not POST on the CMP VBIOS until the A100 VBIOS is flashed (expected, and reachable over the EEPROM path), and
the host board needs large (64-bit) BAR support or it hangs at POST. Note that block 39 bit 0 is DEVIDB's top bit, in
the same block as the Gen3 speed bit: a block 39 record carries both. ffcalc plans the device ID only when asked
(`--a100`, since 2026-11-24, together with the whole `PCIE_MAGIC_BITS_D` word); its authors list that route as a
community one they have not reproduced. The lab has not changed a device ID.

## Other FF fields (Community)

Decoded from the Allspark card's read-back stream. Positions inside a block come from ffcalc's map where it has one;
the rest is the guide's label. **These words are that die's blocks: each carries every other bit of its block as that
card read it. Never copy one; compute your own from your replay.**

| Chain, block | Allspark words | What the guide says | Notes |
|---|---|---|---|
| 1, 23 | `0x0FE805C1` then `0x000005C1` | NVLINK_DISABLE to 0, then "OFA + SYS_PIPE (MIG) enable" | ffcalc: `NVLINK_DISABLE` (`0x820684`, defective `0x82068C`) is block 23 bits 0 to 2, `SYS_PIPE_DISABLE` (`0x8203A4`, defective `0x8203AC`) bits 4 to 11; bit 3 is cleared in the second record (the guide's "OFA"; a label, not a mapped field) |
| 1, 8 | `0xF9060201` then `0x01060201` | GPC_DISABLE `0xE0` to `0x20`, then NVDEC enable | block 8 bits 11 to 15 go from 1 to 0 in the second record; ffcalc maps them as `NVDEC_DISABLE` (chain 1 bits 139 to 143, 5 NVDECs) |
| 1, 9 | `0x00000241` | NVJPG enable | ffcalc: chain 1 bit 146 (block 9 bit 2) and bit 371 (block 23 bit 3) are the NVJPG and OFA disables as a pair; which is which is not settled |
| 1, 26 | `0x00000681` | RECONFIG to 0 (the last 4 SMs) | |
| 2, 78 | `0x00001382` | clear the FP and SM speed throttle (FFMA, FMLA16, FMLA32, IMLA0 and 1) | |
| 2, 79 | `0x2E0013C2` | IMLA2, 3, 4 speed selects (int8) | data `0x2E00`, not 0 |

### MIG, NVDEC, NVJPG and OFA on one card (repeaterdroid)

A second community card cleared these four fields in rows 314 to 317 and read every option and status register back
after a bus reset, with no other change in `0x820200` to `0x820EFF`; on that die all four defect words were 0.

| Chain 1 bits | Block | Field (option / status register) | Before | After | That card's record |
|---|---|---|---|---|---|
| 372 to 379 | 23 bits 4 to 11 | `SYS_PIPE_DISABLE` (`0x8203A4` / `0x820E30`) | `0xFE` (only GR0: MIG `1g.64gb` alone) | 0 | `0x000805C1` (block 23 `0x0FE8` to `0x0008`) |
| 139 to 143 | 8 bits 11 to 15 | `NVDEC_DISABLE` (`0x820378` / `0x820C24`) | `0x1F` | 0 | `0x00000201` (block 8 `0xF800` to `0x0000`) |
| 146 | 9 bit 2 | NVJPG or OFA (`0x820370` / `0x820C0C`, `0x8202D8` / `0x820E34`) | 1 | 0 | `0x00000241` (block 9 `0x0004` to `0x0000`) |
| 371 | 23 bit 3 | the other of NVJPG and OFA | 1 | 0 | `0x000005C1` (block 23 `0x0008` to `0x0000`) |

Results on that card under the stock driver: MIG profiles `8g.64gb`, `4g.32gb`, `2g.16gb`, `1g.8gb` and `1g.8gb+me`, eight
`1g` slices at once, and CUDA running in three mixed slices; 5 NVDECs (5 concurrent 1080p hardware sessions); NVJPG
hardware decode; OFA API 5.0. The two single bits map onto NVJPG and OFA as a pair; which is which is not settled.

- **Those words are that card's blocks.** Its block 8 held only the NVDEC bits (its GPC and FBPA bits there were 0),
  so `0x00000201` cleared everything. On the lab's cards block 8 also carries GPC and FBPA bits: that word would
  switch them on. Build block 8 and block 23 from your own replay, keeping the GPC, FBPA and NVLink bits as planned.
- **Targets.** `SYS_PIPE_DISABLE` targets its defective word (`0x8203AC`), like the other floorsweep fields. Clear the
  NVDEC, NVJPG and OFA bits only when their status registers show no defect beyond the disable.
- **MIG mode toggles reset the memory layout.** `nvidia-smi -mig 1` (or 0) runs an in-driver reset that drops the 64
  GiB geometry back to 8 GiB until a reboot; reboot right after toggling MIG mode.
- Chain 1 bits 78 to 82 (display and display heads) are left alone: GA100 has no display hardware.

Two blocks carry two records each on the Allspark card (8 and 23); the later one stands. In one session you can instead
burn each shared block once with its final value. NVLink also needs the bridge path and a reference clock, which a
stock card does not carry; the Allspark guide lists bridging the `U11` pins, `refclk = pcie`, or an external 156.25 MHz
reference. In the lab's volatile test on a 10 GB card, `NVLINK_DISABLE` = 0 left the driver reporting no NVLink.

## Column fuses (not FF records)

These options are set straight from rows near the start of the array. An FF record cannot reach them. The Allspark
guide describes each as an enable bit with a paired undo bit: burning the undo bit (0 to 1) forces the option back to 0,
so a column burn cannot be taken back by burning more. The table gives the bit that guide burns for each option (rows
come in redundant pairs); none of them is verified by the lab:

| Option | Rows, bit the guide burns (Allspark) |
|---|---|
| `OPT_ECC_EN` (`0x820228`) | rows 6 and 7, bit 28 (that card: `0x86500003` to `0x96500003`) |
| `OPT_ROW_REMAPPER_EN` | rows 48 and 49, bit 5 |
| `OPT_VGX_EN` (vGPU) | rows 22 and 23, bit 19 |
| `OPT_OPENGL_EN` | rows 6 and 7, bit 18 |
| FP64 full rate (DP speed select undo) | rows 6 and 7, bit 27 |
| TTU and poison (`FEATURE_READOUT` bit 9 clear) | rows 2 and 3, bit 21 |

**Contested.** Other members read rows 6 and 7 differently: `ECC_EN` bit 28 and `ECC_EN_CONTROL` bit 29, both
already 1 on two cards, so that "the only state reachable by burning more bits is (1,1)", ECC off. truwor's answer to
a plan that burned `ECC_EN_CONTROL`: "Never do this". IFF writes to ECC are reset by FWSEC at startup (Zagitta). In
the lab's volatile test on a 10 GB card `OPT_ECC_EN` = 1 applied in hardware but ECC mode stayed N/A: the fuse alone
did not turn ECC on. Members report ECC through software (cmpunlocker or gpu-unlock). Read your own rows 2 to 7 and 48 and 49 and the wiki's
[ECC](https://cmp.wiki/wiki/ECC) page before you consider any column burn. The lab has burned none.

Out of reach by any fuse, per the Allspark guide: 10-bit PCIe tags (no undo bit), NVENC, display and RT cores (not on
the GA100 die).

## Computing a record by hand

0. **Stop before anything** unless all of these hold: the read is your card's (die ID rows 8 to 15 match), FUSECTRL is
   idle (`0xE0040000`), CRC_STATUS `0x820070` is `0x55`, and `DEBUGCTRL` `0x820060` is 0. At the burn, the gate checks
   of [How the fuses work](#how-the-fuses-work) come on top.
1. **Read the card cold** with no driver bound: the fused, defective and status words, and all 512 rows read twice in
   one session with matching passes (`tools/vfi_snap.py --rows` does both). ffcalc's scan can merge rows from older
   files, and [gpcprobe](https://cmp.wiki/wiki/Gpcprobe) reads the masks with the driver bound: neither is a fresh
   two-pass capture. Keep the fused, defective, status and replayed values apart. Keep the read private: it identifies
   the die.
2. **Replay the FF pool:** read your card's IFF start (`IFF_RECORD` `0x820050` & `0x1FF`, stock 488). For each row from
   222 up to the IFF start: skip 0 and `0xFFFFFFFF`, stop if any other row has bit 5 set, else decode (chain, block,
   data); the last row for a (chain, block) wins. Decode every field from the replayed blocks and compare with the option registers you read. If they
   differ, stop: your map or your read is wrong.
3. **Set the targets:** the defective words for the floorsweep fields you want, 0 for the PCIe fields.
4. **Write the new blocks:** start from each replayed (chain, block), change only the target bits, keep all other 16
   bits (the code below). If a block you need to change has no record in the pool, stop: the rows do not tell you its
   other bits, and assuming 0 can switch something else on.
5. **One record per changed block:** `word = (new << 16) | (block << 6) | chain`. Check bit 5 is 0, the word is not 0
   or `0xFFFFFFFF`, and it decodes back to your chain, block and data. When a block carries several goals (block 8,
   block 39), merge every target bit into its one record.
6. **Rows:** the first blank row after the last used FF row, then upward. Every row from there to the IFF start must be
   0. Keep a reserve (the lab keeps 16 blank rows); most cards had 160 to 196 blank, one new card only 37.
7. **Order:** compute with the block 8 record last, then memory with the block 19 (FBP) record last, then PCIe. Each
   prefix of the plan is then a safe card: no GPC on before its TPCs and PES, no FBP on before its FBIO, FBPA and
   ROP_L2 pairs. Your first row is the first real record of the plan, never a dummy word. Read each row back after it is
   burned and compare all 32 bits; a tool bug that burned only the top half of each word left one member's card at x1
   with no driver. If a burn stops partway, power off and plan again from a fresh read.
8. **Simulate:** replay old rows plus new rows in row order, decode every field, and compare with your targets. Then run ffcalc
   `sim` and have another person check it. "Two models agreeing isn't verification" (galygious).

Step 4 as code, for a field on chain `c` that starts at chain bit `s`, `width` bits wide, with target value `t`:

```
new = dict(replayed)                 # (chain, block) -> 16-bit value; replayed itself is never changed
for i in range(width):
    b = s + i
    key, pos = (c, b // 16), b % 16
    if key not in replayed:
        raise SystemExit("no record for chain %d block %d: stop" % key)
    bit = (t >> i) & 1
    new[key] = (new[key] & ~(1 << pos)) | (bit << pos)
```

**Worked example: the GEN23 record.** Chain 2 block 49 reads `0x00E4` (bits 2, 5, 6, 7). Clear bits 6 and 7 and
keep bits 2 and 5: `0x0024`. Word: `0x0024 << 16` = `0x00240000`, `49 << 6` = `0xC40`, chain `2`:
`0x00240000 | 0xC40 | 0x2` = `0x00240C42`. Bit 5 of `0x0C42` is 0.

## After the burn: what to read

A read in the same session only proves the rows were written: `CMD_SENSE` does not re-apply the FF chain. Power off
fully, cold boot, and read again:

| Read | Expect |
|---|---|
| CRC_STATUS `0x820070` | `0x55` |
| DSOV `0x820084` | 1 on an 8 GB card (normal after every cold boot) |
| the 512 fuse rows | only your planned rows changed, compared with your pre-burn read |
| `GPC_DISABLE`, `TPC_GPCn_DISABLE`, `PES_DISABLE` | the defective words |
| SM count | the ceiling minus 4, the ceiling under cmpunlocker |
| `FBP_DISABLE` | the FBP defective word (`0x840`, `0x009`, `0x024` on the lab's cards) |
| FBIO, FBPA, ROP_L2 | `pair(FBP)` |
| `PCIE_MAGIC_BITS_D` | `0x14680000` |
| the three other PCIe fields | 0 |
| `lspci -vv` | `LnkCap` 16 GT/s x16 |
| your planner on the new read | nothing left to burn |

## Machine-readable field table

Positions are chain bit offsets: block = bit // 16, position = bit % 16. `defective` and `status` are BAR0
addresses. Floorsweep target = defective word.

```json
{
  "record": {"data": "bits 31:16", "block": "bits 15:6", "chain": "bits 4:0", "bit5": 0, "rule": "last record per (chain, block) wins"},
  "ff_rows": [222, 486],
  "iff_start": "IFF_RECORD 0x820050 & 0x1FF, stock 488; plan below it",
  "bit5": "a word with bit 5 set ends the FF pool; never burn one; 0xFFFFFFFF rows are skipped",
  "burn_gate": {"DSOV 0x820084 bit 0": 0, "DEBUGCTRL 0x820060": 0, "CRC_STATUS 0x820070": "0x55", "FUSECTRL 0x820000": "0xE0040000 idle"},
  "chain1": {
    "FBIO_DISABLE":     {"fused": "0x82036C", "defective": "0x8205D4", "status": "0x820C14", "bit": 83,  "width": 24, "mark": "Lab"},
    "FBPA_DISABLE":     {"fused": "0x820368", "defective": "0x8205D0", "status": "0x820C18", "bit": 107, "width": 24, "mark": "Lab"},
    "GPC_DISABLE":      {"fused": "0x820350", "defective": "0x8205C4", "status": "0x820C1C", "bit": 131, "width": 8,  "mark": "Lab"},
    "TPC_GPC0_DISABLE": {"fused": "0x820760", "defective": "0x8205C8", "status": "0x820C38", "bit": 187, "width": 8,  "mark": "Lab"},
    "TPC_GPC1_DISABLE": {"fused": "0x820764", "defective": "0x820508", "status": "0x820C3C", "bit": 195, "width": 8,  "mark": "Lab"},
    "TPC_GPC2_DISABLE": {"fused": "0x820768", "defective": "0x82050C", "status": "0x820C40", "bit": 203, "width": 8,  "mark": "Lab"},
    "TPC_GPC3_DISABLE": {"fused": "0x82076C", "defective": "0x820514", "status": "0x820C44", "bit": 211, "width": 8,  "mark": "Lab"},
    "TPC_GPC4_DISABLE": {"fused": "0x820770", "defective": "0x820564", "status": "0x820C48", "bit": 219, "width": 8,  "mark": "Lab"},
    "TPC_GPC5_DISABLE": {"fused": "0x820774", "defective": "0x8205AC", "status": "0x820C4C", "bit": 227, "width": 8,  "mark": "Lab"},
    "TPC_GPC6_DISABLE": {"fused": "0x820778", "defective": "0x820B84", "status": "0x820C50", "bit": 235, "width": 8,  "mark": "Lab"},
    "TPC_GPC7_DISABLE": {"fused": "0x82077C", "defective": "0x820B80", "status": "0x820C54", "bit": 243, "width": 8,  "mark": "Lab"},
    "PES_DISABLE":      {"fused": "0x820690", "defective": "0x820698", "status": null,       "bit": 251, "width": 24, "mark": "Lab"},
    "FBP_DISABLE":      {"fused": "0x820364", "defective": "0x8205CC", "status": "0x820D38", "bit": 307, "width": 12, "mark": "Lab"},
    "ROP_L2_DISABLE":   {"fused": "0x8202C4", "defective": "0x8205E8", "status": null,       "bit": 319, "width": 24, "mark": "Lab"},
    "NVLINK_DISABLE":   {"fused": "0x820684", "defective": "0x82068C", "status": "0x820DB8", "bit": 368, "width": 3,  "mark": "Community"},
    "SYS_PIPE_DISABLE": {"fused": "0x8203A4", "defective": "0x8203AC", "status": "0x820E30", "bit": 372, "width": 8,  "mark": "Community"},
    "NVDEC_DISABLE":    {"fused": "0x820378", "status": "0x820C24", "bit": 139, "width": 5, "stock": "0x1F", "mark": "Community", "note": "ffcalc --mig; repeaterdroid: 5 NVDECs after the clear"},
    "NVJPG_OFA_PAIR":   {"fused": ["0x820370", "0x8202D8"], "status": ["0x820C0C", "0x820E34"], "bits": [146, 371], "mark": "Community", "note": "ffcalc --mig; which bit is NVJPG and which OFA is not settled"}
  },
  "chain2": {
    "PCIE_DEVIDA":             {"reg": "0x8204D8", "bit": 593, "width": 16, "mark": "Community"},
    "PCIE_DEVIDB":             {"reg": "0x82056C", "bit": 609, "width": 16, "mark": "Community"},
    "OPT_DISABLE_GEN3_SPEED":  {"reg": "0x820250", "bit": 633, "width": 1, "target": 0, "mark": "Lab"},
    "PCIE_MAGIC_BITS_D_bit25": {"reg": "0x820520", "reg_bit": 25, "bit": 755, "width": 1, "target": 0, "note": "the register is chain bits 730 to 761; reads 0x16680000 stock, 0x14680000 after; never plan the whole word", "mark": "Lab"},
    "OPT_PCIE_BOOT_GEN23_DIS": {"reg": "0x82057C", "bit": 790, "width": 1, "target": 0, "mark": "Lab"},
    "OPT_PCIE_BOOT_GEN3_DIS":  {"reg": "0x820580", "bit": 791, "width": 1, "target": 0, "mark": "Lab"}
  },
  "lab_words": {
    "memory_0x852_to_0x840": ["0x80070141", "0x06010181", "0x018001C1", "0x18000501", "0x420004C1"],
    "pcie": ["0x058209C2", "0x00510BC2", "0x00240C42"],
    "note": "historical: these words fit only blocks that read the same old values; matching values do not identify a card or validate a plan; compute your own"
  }
}
```

## Related

- [GUIDE.md](GUIDE.md): the whole route; section 1.8 for planning, 4.1 for verification.
- [ALLSPARK.md](ALLSPARK.md): the full A100 conversion, the column burns and the burn mechanics.
- [cmp170hx-mig-nvdec-nvjpg-ofa-unlock](https://github.com/repeaterdroid/cmp170hx-mig-nvdec-nvjpg-ofa-unlock) (repeaterdroid): 8-way MIG, 5 NVDECs, NVJPG and OFA from four
  chain 1 records, with every register delta.
- cmp.wiki: [Fuses and floorsweep maps](https://cmp.wiki/wiki/Fuses_and_floorsweep_maps),
  [Unlock without bricking](https://cmp.wiki/wiki/Unlock_without_bricking),
  [ECC](https://cmp.wiki/wiki/ECC), [NVLink](https://cmp.wiki/wiki/NVLink).
- [cmp170hx-ffcalc](https://github.com/sayhellotojungle/cmp170hx-ffcalc): the field map, the planner and `sim`.
