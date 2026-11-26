# Allspark: the complete CMP 170HX to A100 unlock guide

> **Author:** Petri Krohn (`@petrikrohn_26497`), 2026-11-18 to 2026-11-20, hosted here with the author's credit.
> For this repository's `cimp` Pico 2 W glitch hunter, 80 GB `cmpunlocker` driver patch and PCIe Gen4 boot service
> (without an A100 device-ID rebrand), see [`docs/GUIDE.md`](GUIDE.md) and the
> [Allspark page on cmp.wiki](https://cmp.wiki/wiki/Allspark:_CMP_170HX_to_A100_unlock_guide).

Allspark is the single, self-contained reference for converting an NVIDIA CMP 170HX mining card into a
full A100: how the lock works, how to open the fuse-write gate (by RIR on the 10GB SKU or by voltage
glitch on the 8GB SKU), the exact BAR0 fuse-write mechanics, the ordered burn of every feature, the
A100 VBIOS flash, and the driver-side enablement of ECC, MIG, vGPU, SR-IOV, power states, and
overclock. It brings together work the community learned in pieces, across months of chat, and
reconciles it into one process. Where a point is still contested, this guide says so and gives both
readings.

Built 2026-11-18, extended 2026-11-19 with the in-window glitch result, the fuseless-fuse region map,
the RIR two-layout write discipline, and the brick-recovery method, and extended 2026-11-20 with the
Goldilocks confirm registers and pre-burn re-sense, the card-dependence of re-glitching, the memory
clock after the A100 rebrand, and the NVLink refclk and solder-bridge options. Add later findings with
their own date so the record stays current.

This document modifies hardware permanently, voids any warranty, and may be unlawful to apply to
hardware you do not own or to misrepresent a modified card as a genuine product. It is provided for
research and education, as-is, with no warranty. You are responsible for your own hardware and for how
you use a modified card. A rebranded card is for driver compatibility on your own systems, not for
resale or passing off as a genuine A100. Secret and key material from the firmware leak (signing keys,
debug keys, the VRM vendor password, license-server spoofing) is deliberately left out; this is the
process, not a key dump.

## What you get

A fully unlocked card gains, in one pass: the full SM count (up to 128, from a floor-swept 70 to 74),
full 64 or 80 GB HBM, PCIe Gen3 and Gen4, NVLink, full-rate FP64 and int8 tensor, DRAM and SRAM ECC,
MIG, vGPU, hardware SR-IOV (with the A100 rebrand), NVDEC/NVJPG/OFA, OpenGL, P2P, the A100 device
identity and VBIOS, and unlocked power states, VF curve, TDP and overclocking.

## The workflow for high success

Most bricks are a step done out of order or skipped, not bad luck. This is the order that works; the
rest of the guide is the detail behind each step.

1. Set up the host and detach the driver (next section). Nothing below is safe with the stock driver
   attached.
2. Dump the full fuse array and BAR0 before you touch anything. This is your recovery reference and
   your floorsweep source. Almost every unrecoverable brick is a card that had no clean pre-dump.
3. Derive this card's plan from its own fuses: the floorsweep (Part 4a) and the complete record set you
   intend to burn (Part 4). Never carry another card's values over.
4. Open the gate once: RIR on a 10GB card, one clean voltage glitch on an 8GB card (Part 2 and 2a).
5. Arm the gate, then SW-IFF test the entire plan (Part 3). SW-IFF is volatile and free; prove every
   value behaves before any permanent write.
6. Burn the whole plan in this one session (Part 4). This is the safe default because a permanent burn
   locks some cards out of re-glitching, but it is card-dependent, not universal (Part 2a): other
   operators re-enter Goldilocks freely after burns, and a `GFW_BOOT = 0x1` reading alone does not block
   a re-glitch. Plan for the worst case and do not count on a second glitch.
7. Dump and read back the post-burn state, then full cold power cycle (PSU off and unplugged, not an OS
   reboot).
8. Flash the matching A100 VBIOS immediately (Part 5). A burned A100 DEVID will not POST on the old CMP
   VBIOS; that is expected and recoverable, not a brick.
9. Enable and verify the driver-side features (Part 6 and 7).

A note on LLM assistants. Much of this community derives per-card values and writes the burn scripts
with an LLM assistant. A weak or low-effort model produces a wrong floorsweep and a dead card. If you
use one, run a top model at maximum effort, feed it only a fresh dump of the card in front of you,
never let it carry another card's values across, and SW-IFF-test everything it gives you before you
burn. The model is a calculator, not an authority.

## Where most cards die

Ranked by how often it bites, from the community's brick record. Each has its fix later in the guide.

| Failure | Signature | Fix |
|---|---|---|
| Glitch grind | days of attempts, never arms | in-window single pulse (Part 2a) |
| GFW wedge | `GFW_BOOT=0x1`, no driver | revert the bad burn vs the pre-dump (Part 8); 0x1 alone is not always a wedge |
| Re-glitch lockout | stuck after one burn (card-dependent) | burn the whole plan in one session (Part 2a) |
| Two-layout write | instant brick on first write | decode under both layouts first (Part 3) |
| Row out of window | FF write rejected | start after the factory records (Part 4) |
| Warm state | works on one host, not this one | full cold unplug, driver detached (Setup) |
| No ECC counters | `nvidia-smi` blank | InfoROM graft (Part 6) |

## Setup and hygiene

Do this before any gate work. Half the "it will not work" reports are a setup miss.

- **Detach the driver, do not just unbind it.** Blacklist `nvidia` and `nouveau` in `/etc/modprobe.d`
  and cold reboot, or stop everything using the GPU and `rmmod nvidia_uvm nvidia_drm nvidia_modeset
  nvidia` until `lsmod | grep nvidia` is empty. The driver takes control of the VRM and the fuse path;
  with it loaded your glitch and your flash fight it.
- **Kernel command line.** `iomem=relaxed` so BAR0 can be mapped raw. Add `intel_iommu=on iommu=pt` (or
  the AMD equivalent) if you will do SR-IOV.
- **Host BIOS: Above-4G Decoding and Resizable BAR are mandatory** for the A100 identity. Without large
  or 64-bit BAR support the machine hangs in BIOS at POST and will not boot. A cheap board without it
  will trap the card; most server boards are fine.
- **Flash one card at a time.** `nvflashk` device selection by BDF is fiddly; a single card in the
  machine removes the ambiguity.
- **Dump first.** Save a full fuse-array and BAR0 dump before the gate is open, and again after the
  burn. The pre-dump is the only thing that makes a bad burn recoverable, and it is your floorsweep
  source. Read is safe; only writes are irreversible.

## Part 1: how the lock works

The 170HX is the same GA100 die as the A100 with features fused and firmware-locked for the mining SKU.
Four fuse mechanisms matter:

- **OTP rows.** 512 rows of 32 fuse bits, burn 0 to 1 only. Row meaning is per-die, mapped by a
  chain and offset scheme.
- **RIR (Repair Information Record).** 16 shadow records, each rewrites one fuse bit by absolute
  address. Usable on the 10GB SKU; factory-poisoned (all 16 burned) on the 8GB SKU, which is why the
  8GB SKU needs the glitch.
- **FF (fuseless fuse).** Instructions in spare rows, last write wins per `(chain, offset)`, format
  `data16 << 16 | offset10 << 6 | chain5`. This is the permanent unlock path for anything fuseless.
- **Column fuses.** The first 90 or so fuse slots, mapped directly to the OPT shadow bits. An FF record
  cannot touch these; they are enable/disable pairs with a value bit and an undo bit, and setting the
  undo bit (0 to 1, legal) forces the option back to 0. ECC, the row remapper, FP64, and TTU are column
  fuses.

Volatile alternatives exist for testing: an IFF record edits a fuse value for the current boot only,
and a plain host override write to the feature-override block (how cmpunlocker gives compute and memory
today) is lost on reset.

The gate that governs all fuse writing, bottom to top:

```
DISABLE_SW_OVERRIDE = 0   ->   EN_SW_OVERRIDE = 1   ->   SECURED_BURN_FEATURE_ENABLE = 0   ->   FF/column burns land
```

`DISABLE_SW_OVERRIDE` (DSOV) is a datapath gate, not a privilege gate, and it is uniquely not restored
by a fuse resense, which is why both the RIR clear and the glitch persist until a power cycle.

Register quick-reference for this guide:

```
0x00820000  FUSECTRL        controller; CMD in low bits (CMD_READ = 1, CMD_WRITE = 2, CMD_SENSE_CTRL = 3), state [20:16], IDLE = 4
0x00820004  FUSEADDR        target row / slot; under RWL=1 taken mod 8
0x00820008  FUSERDATA       read data (read-only)
0x0082000C  FUSEWDATA       write data (write-only); value written is wanted & ~current (a delta)
0x00820040  EN_SW_OVERRIDE  arms software override
0x00820050  IFF_RECORD      IFF window: start = v & 0x1FF, last = (v>>16) & 0x1FF; factory 0x01FB01E8
0x00820060  DEBUGCTRL       bit 1 = RWL (RIR macro select); read 0 before any FF burn
0x00820070  CRC_STATUS      0x55 when fuses parsed cleanly
0x00820078  OPT_EN_PROGRAM  must read 1 to program
0x0082007C  OPT_DIS_PROGRAM must read 0 to program
0x00820084  DSOV status     the gate; 0 = open
0x00820088  IFF_SW_FUSING   set to 1 to apply an IFF record
0x00118234  GFW_BOOT        GSP boot progress: 0x3FF = POSTed clean; 0x1 = a failed secure-boot step, not proof of an un-POSTed or unglitchable card (contested, Part 8)
0x008200F4  FUSEWDATA_PLM   write-data privilege; 0xFFFFFFFF when the data path is open (0xFFFFFF8F when still gated)
0x008200FC  PRIV_MASK       general privilege mask; 0xFFFFFFFF when open (the SBFE PLM lives here too)
0x00821108  SECURED_BURN_FEATURE_ENABLE   bit 30, PLM 0x008200FC; clear to let FF rows take bits; a re-sense re-latches it (Part 2)
0x0082048C  OPT_SECURE_FUSE_WDATA_WR_SECURE  clear so FUSEWDATA writes land
0x008204D8  OPT_PCIE_DEVIDA   SKU id fuse (0x2082 10GB, 0x20c2 8GB); A100 DEVID to burn is set by the VBIOS (Part 4)
0x00820394  OPT_PCIE_LANE_DISABLE     disabled PCIe lanes (0 = none)
0x008205E4  OPT_PCIE_LANE_DEFECTIVE   silicon-defective lanes (0 = none); caps cannot fix these
0x00823824  FEAT_OVR_ROW_REMAP  do not write value 3 (a confirmed hardware kill, see Part 8)
0x00823808  FEAT_OVR_QUADRO     do not force the full 0xffffffff mask (booter 0x29, see Part 8)
```

## Part 2: open the fuse-write gate

The goal of this part is `DSOV = 0` with the override armed and the burn gate down. Pick the path for
your SKU.

**10GB SKU: clear DSOV with two RIR records.** The RIR macro has free slots (10GB cards have all 16
free). Select it with `DEBUGCTRL` bit 1 (RWL) set, then write the two records that force the PRI and
RED copies of `DISABLE_SW_OVERRIDE` (row 0 bit 5 and row 1 bit 5) to 0. Read the RIR two-layout hazard
in Part 3 before writing anything with RWL set.

```
slot 464  FUSEWDATA 0x00150000   DISABLE_SW_OVERRIDE (PRI)  row 0 bit 5 -> 0
slot 465  FUSEWDATA 0x00950000   DISABLE_SW_OVERRIDE (RED)  row 1 bit 5 -> 0
```

**8GB SKU: clear DSOV with a voltage glitch.** The RIR macro is factory-poisoned, so RIR is closed.
Voltage-glitch the NVVDD rail (driven by the on-board MP2888B VRM) during the reset window to corrupt
the devinit fuse-sense so DSOV latches 0. See Part 2a.

**Then, for both paths, arm the gate:**

1. `reg w 0x820040 1` to set `EN_SW_OVERRIDE = 1` (host-writable once DSOV is 0).
2. Clear `OPT_SECURED_BURN_FEATURE_ENABLE` (`0x821108`, bit 30) to 0 under the override. While it reads
   1, FF rows will not take bits.
3. Clear the write-secure fuses that gate the data path, for example
   `OPT_SECURE_FUSE_WDATA_WR_SECURE 0x0082048C`, so `FUSEWDATA` writes land.
4. Confirm `OPT_EN_PROGRAM 0x820078 = 1` and `OPT_DIS_PROGRAM 0x82007C = 0`. The glitch can clear
   `EN_PROGRAM`; restore it if needed.
5. Verify the armed state over BAR0. The community calls this state Goldilocks; it is the same thing
   this guide means by armed:

```
reg r 0x820000   # FUSECTRL        = 0xE0040000  (idle, no BADF canary)
reg r 0x820084   # DSOV            = 0x00000000  (gate open)
reg r 0x820070   # CRC_STATUS      = 0x00000055  (fuses parsed cleanly)
reg r 0x8200FC   # PRIV_MASK       = 0xFFFFFFFF  (general privilege open)
reg r 0x820040   # EN_SW_OVERRIDE  = 0x00000001  (override armed)
reg r 0x8200F4   # FUSEWDATA_PLM   = 0xFFFFFFFF  (data path open; 0xFFFFFF8F means step 3 did not land)
```

**Re-sense before burning (what the community burn planners do).** After reaching the armed state, a
re-sense reloads the fuse defaults into the shadow so the burn starts from a clean, known base:
`reg w 0x820000 3` (`CMD_SENSE_CTRL`), then re-read `FUSECTRL` for `0xE0040000` idle with no canary. A
re-sense asserts `EN_PROGRAM` (GPIO 19) and re-latches `OPT_SECURED_BURN_FEATURE_ENABLE` to its fused
value, so clear SBFE (step 2) after the re-sense, not before, or the gate closes again under you.
Re-confirm `EN_PROGRAM 0x820078 = 1` and `DIS_PROGRAM 0x82007C = 0` once more before the first write.

**Emerging finding (2026-11-19), unconfirmed: SBFE may be the real target, not DSOV.** One operator
reports flipping `SECURED_BURN_FEATURE_ENABLE` directly with the glitch, without clearing DSOV, and
still burning FF records. Both bits live on row 0. It is a single report; treat the DSOV path above as
the known-good one and SBFE-direct as a lead to watch.

## Part 2a: the voltage glitch (8GB SKU)

The glitch forces the fuse gate open without RIR. It is the only entry on the 8GB SKU. Software-only
glitching has been tried and is considered hopeless by the people who tried it; plan on a hardware rig.

**What it does.** During the card's reset or devinit window, disrupt NVVDD into a short dip, timed
against PERST (PEX_RST), over the MP2888B PMBus interface. The fault corrupts the fuse-sense so the
gate resolves open. The state holds until the next full power cycle.

**Wire three taps.** I2C SDA and SCL at the test points next to the MP2888B, the PERST (PEX reset)
line, and an NVVDD sense point. Keep the I2C leads short. The reference rigs are a Raspberry Pi Pico 2
or an RP2040 running the open glitch firmware (Software and references at the end). On an A30X-based
card the BlueField-2 I2C can drive the glitch instead of an external rig.

**The in-window single-pulse result (2026-11-19).** A measured campaign pinned the two rules that cost
the community on the order of a hundred thousand shots to learn, and both are counter-intuitive:

- **The arming dip fires in-window, after PERST release**, not before it. A dip at roughly +50 us after
  PEX_RST release arms the gate; a dip at -60 to -80 us before release flips fuses but never lands the
  armed, usable state. There is a hard boundary: around +50 us faults every time, at or past about
  +100 us nothing faults.
- **Single pulse only.** The armed class exists at `pulses = 1` in this window. The older multi-pulse
  and triple-dip shapes produce the wrong, near-miss flips, never the clean arm.

A representative armed profile (dalzyyy `ga100vfi` host client, Pico 2):

```
v_dip (commanded)   365    PMBus VOUT code, a slew target, NOT the actual rail depth
t_dip               +50    us AFTER PEX_RST release (in-window)
pw                  196     single pulse width in us (196 to 204 all armed)
pulses              1       single pulse; multi-pulse never arms
v_restore           750     restore command level
t_restore           -20     restore issued 20 us before window close
target              MP2888B at I2C 0x25, VOUT_COMMAND on NVVDD
```

**Commanded voltage is not rail voltage.** The `v_dip` code is a nominal slew target; the rail sags
slower and shallower than commanded, because the VRM is slew-rate limited. Scope captures on one rig
read a commanded 306 code as roughly 598 mV mean, 65 mV minimum, over an 811 us sag. So do not chase an
exact millivolt number from someone else's rig; command a code, watch the result.

**Rail authority.** If the VRM holds near its previous voltage and the dip never lands, the VRM
write-protect must be unlocked (a vendor password write that the glitch tools handle) and the loop
control set for a clean 1:1 `VOUT_COMMAND` slope (`MFR_DC_LOOP_CTRL` register 0x30, `0xce64` to
`0xce04`); both the requested-voltage and minimum-voltage VID registers must be overwritten to drop
below about 700 mV. The exact password is not reproduced here; the community glitch tools carry it.

**The armed signature is all three at once:** `DSOV = 0` and `CRC_STATUS = 0x55` and the privilege mask
fully open (`0xffffffff`). A two-field match (DSOV cleared but privilege closed, mask `0xfffffefe`, CRC
`0x00`) is the near-miss class, not a usable glitch; it is a single atomic fault that the aggressive
deep-dip zone produces every time. Judge by all three, never by DSOV alone. Power-cycle out of any
corrupted state before retrying; a warm card drifts, so let it cool or vary the dip each attempt.

**Earlier data point, kept for context.** An earlier run on a different card and rig landed clean around
a commanded 335 code with a single pulse at -80 us (before release) on the 5th try. The 2026-11-19
in-window result supersedes the before-release timing as the reliable target; the earlier run most
likely landed near-misses when it reported before-release hits. Sweep your own card and judge by the
three-field armed signature.

**Burn everything in one glitch session.** You cannot test or burn before the glitch, because the gate
is shut until it lands. So plan the complete record set in advance (Part 4, with your card-specific
floorsweep from Part 4a), land one clean glitch, and in that same session without a power cycle complete
the arming steps in Part 2, SW-IFF-test the whole plan (Part 3), and burn it all.

How hard a card is to re-glitch after a burn is card-dependent, not a rule. On some cards even one
permanent burn changes the glitch, CRC and privilege behavior enough that re-glitching becomes much
harder or impossible (one operator was stuck three days after burning a single fuse). On others it is a
non-issue: operators report re-entering Goldilocks within ten tries after burns, many times over. A
`GFW_BOOT = 0x1` reading does not by itself mean the card cannot be re-glitched. One operator with GFW at
0x1 re-ran the glitch, re-entered Goldilocks, and had the card accept new FF writes. So treat the first
clean glitch like a diamond and plan to need only one, but a burned card is not automatically a dead end
for further writes. Judge by the armed signature on the card in front of you, not by GFW alone.

## Part 3: the fuse-write mechanics

With the gate open, this is how each write lands. Test volatile first, then burn.

**The RIR two-layout hazard, read before any write.** The same `FUSEWDATA` word means different things
depending on whether the RIR macro is selected (`DEBUGCTRL` bit 1, RWL). With RWL = 0 it is an FF
record; with RWL = 1 it is one or two RIR records that rewrite arbitrary fuse bits by absolute address.
A word that is a harmless FF invalidation under one layout can be a catastrophic RIR write to row 0
(`DIS_PROGRAM`) under the other, which is an instant, unrecoverable brick. The four historical bricks
were all this class. Before every `CMD_WRITE`:

1. Read `DEBUGCTRL` back immediately before the write and confirm RWL is what you intend. Under RWL = 1,
   the RIR row is `FUSEADDR mod 8`, so a missing `FUSEADDR` does not fail safe on its own.
2. Decode the payload under both layouts and abort if the unintended layout yields any live
   (enable = 1) record targeting rows 0 to 7 (the `DIS_PROGRAM` and DSOV control region).
3. Place the write at a `FUSEADDR` whose main row reads `0xFFFFFFFF`, so a wrong-domain write burns no
   cells. `FUSEWDATA` is a delta (`wanted & ~current`), so a payload that is a subset of the live row
   burns nothing, which is the fail-safe you want.
4. Read back in the macro you actually wrote, then re-read `DEBUGCTRL`.

This discipline is the line between people who unlock cards and people who brick them on the first write.

**Volatile test (SW-IFF).** Writes an FF record into the IFF window for this boot only; clears on a cold
boot. For each value you intend to burn, land it as SW-IFF and confirm the card behaves (enumerates,
trains the link, allocates the memory):

```
reg w 0x820040 0x00000001        # EN_SW_OVERRIDE = 1
reg w 0x820050 0x012F012F        # IFF_RECORD: use a blank row (here 0x12F) as start and last
reg w 0x820004 0x0000012F        # FUSEADDR = that row
reg w 0x82000C 0x058209C2        # FUSEWDATA = the FF record (example: clear OPT_DISABLE_GEN3_SPEED)
reg w 0x820088 0x00000001        # IFF_SW_FUSING = 1 to apply
```

A fully unlocked card can be run entirely on SW-IFF (full SM, Gen3 x16, full memory, DRAM ECC) with
nothing burned, re-landed each boot by a service. If you only want a reversible unlock, stop here and
script the SW-IFF overlay at boot.

**Permanent burn (FF record).** Per record, confirm the slot is blank, load the record, commit, poll to
IDLE, and read back:

```
reg w 0x820004 0x0000012D        # FUSEADDR = target FF slot (example 0x12D)
reg w 0x820000 0x00000001        # CMD_READ
reg r 0x820008                   # FUSERDATA must be 0x00000000 (blank); STOP if not
reg w 0x82000C 0x00001382        # FUSEWDATA = the FF record (does not read back)
reg w 0x820000 0x00000002        # CMD_WRITE, then poll FUSECTRL [20:16] until = 4 (IDLE)
reg r 0x820008                   # read back to confirm
```

Notes: `CMD_WRITE` runs the full program state machine; program time is about `9.1 us + 5.1 us` per set
bit. Some paths require the fuse programming voltage (VPP) asserted through `FUSE_EN` on GPIO 19 before
`CMD_WRITE`; on a glitched 8GB die in the armed state, FF records have been written and read back without
external VPP. Verify on your own card before relying on either.

**Column fuses** are written the same way but target a column row and set the undo bit; they cannot be
done by an FF record.

## Part 4: the ordered burn

Burn the records below plus your card-specific floorsweep records from Part 4a. Several features share a
single 16-bit fuse word (noted below), and last write wins per `(chain, offset)`, so the later write to a
shared word is the one that stands. Read back after every write.

**Where to start, and how many rows you have.** The free FF rows are card-specific. On the cards
reported, rows 0 to roughly 221 are hard OTP pairs, the factory fuseless records end somewhere around
row 290 to 303, the free region runs from there to about 487, and the IFF window is about 488 to 507.
That is roughly 150 free rows. Dump your card's fuse array, find the first blank row after its factory
records, and start there. "Row out of FF window" means you started past the free region. Sources
disagree on the exact start (300, 304, and 332 have all been reported on different cards), so trust your
own dump, not a number.

The read-back-verified reference stream below is from one 8GB card converted to A100 80GB. It is the
shape to adapt, not to copy: the floorsweep rows (310 to 317) are that die's defect map, and yours
differs. Order matters where a word is shared.

```
row  FF word       chain/off   effect
304  0x058209c2    C2/O39      clear PCIe Gen3-disable
305  0x00510bc2    C2/O47      clear PCIe Gen4-disable (PCIE_MAGIC_BITS_D[25])
306  0x00240c42    C2/O49      clear boot Gen2/3 + boot Gen3 disable
307  0x0fe805c1    C1/O23      clear NVLINK_DISABLE[2:0]
308  0x00001382    C2/O78      clear FP/SM speed throttle (FFMA/FMLA16/FMLA32/IMLA0/1)
309  0x416a0942    C2/O37      DEVIDA 0x20c2 -> 0x20b5 (A100 80GB)
310  0xf9060201    C1/O8       GPC_DISABLE 0xe0 -> 0x20 (CARD-SPECIFIC)
311  0x000002c1    C1/O11      TPC_GPC0 (CARD-SPECIFIC)
312  0x00000301    C1/O12      TPC_GPC0/1/2 (CARD-SPECIFIC)
313  0x07f80381    C1/O14      TPC_GPC6, keep defective TPC5 (CARD-SPECIFIC)
314  0x004103c1    C1/O15      TPC_GPC6/7 + PES (CARD-SPECIFIC)
315  0x1c000401    C1/O16      PES GPC6/7 (CARD-SPECIFIC)
316  0x00000441    C1/O17      PES GPC6/7 (CARD-SPECIFIC)
317  0x00000681    C1/O26      GPC3+GPC4 RECONFIG -> 0 (SM 104 -> 108)
318  0x01060201    C1/O8       NVDEC enable
319  0x00000241    C1/O9       NVJPG enable
323  0x000005c1    C1/O23      OFA + SYS_PIPE (MIG) enable
324  0x2e0013c2    C2/O79      IMLA2/3/4 speed selects (int8)
```

Two offsets appear twice on purpose. `C1/O8` carries GPC_DISABLE then NVDEC, and `C1/O23` carries
NVLINK_DISABLE then OFA and SYS_PIPE/MIG; they are shared 16-bit words, and since last write wins the
later row holds the final value (the earlier one is the intermediate that got more features added). In a
single session you may instead compute each shared word's final combined value and burn it once. Rows
320 to 322 are left out of this stream: a recovered mis-burn, and the optional DEVIDB (see DEVID A and B).

Column-backed fuses, each sets its own undo bit (rows accumulate, OTP only adds bits):

```
ECC enable      OPT_ECC_EN            rows 6/7   bit 28   0x86500003 -> 0x96500003
Row remapper    OPT_ROW_REMAPPER_EN   rows 48/49 bit 5
vGPU license    OPT_VGX_EN            rows 22/23 bit 19
OpenGL          OPT_OPENGL_EN         rows 6/7   bit 18
FP64 full rate  OPT_SM_SPEED_SELECT_DP_CONTROL undo  rows 6/7 bit 27
TTU / poison    FEATURE_READOUT bit 9 clear          rows 2/3 bit 21
```

`NV_P2P` has no undo bit, so P2P is reached by an IFF retarget in the IFF window: a command row redirects
a trap-13 write and a data row opens the `NV_P2P` privilege mask at every reset.

**DEVID A and B.** `DEVIDA` (C2/O37) is the rebrand the driver reads; set it to match the VBIOS you will
flash (A100 80GB is `0x20b5`, A100 40GB targets `0x20f1`). `DEVIDB` (C2/O38) is the SR-IOV and
virtual-function id and turns on vGPU geometry expectations; burn it only if you actually have GRID
drivers and need vGPU, and burn it after the VBIOS flash, not before. DEVIDB must match the chosen VBIOS.
MIG works without DEVIDB.

After burning, read back the whole fuse state, confirm only the words you intended changed, cold-boot,
and re-read to confirm permanence.

## Part 4a: deriving your card's floorsweep records

The SM and memory records are the ones that brick cards, because they must match your die's defects.

1. Read the per-domain status and defect masks: `OPT_GPC_DISABLE 0x820350` and `OPT_GPC_DEFECTIVE
   0x8205c4`, the per-GPC `OPT_TPC_GPCi_DISABLE 0x820760 + i*4` array, and the
   `OPT_FBP/FBPA/FBIO/ROP_L2_DISABLE` and matching `_DEFECTIVE` registers.
2. The effective sweep is `STATUS = DISABLE | DEFECTIVE | CTRL_OPT | (RECONFIG & ~RECONFIG_OVR)`; every
   term adds a disable and only RECONFIG_OVR subtracts.
3. Your recoverable set is `DISABLE & ~DEFECTIVE`: a unit disabled but not defective is good silicon you
   may re-enable; a defective one must stay off.
4. Build the FF data word for each floorsweep offset to clear only the recoverable bits (for example
   `GPC_DISABLE 0xe0 -> 0x20` to enable two good GPCs). Keep every defective TPC masked.
5. Enabling a TPC on an already-active GPC never creates the illegal "GPC with zero live TPCs" state, so
   it is the safest move. Test the whole set with SW-IFF, confirm the SM count and a memory allocation,
   then burn.

## Part 4b: what to expect from the silicon lottery

Capability is set by each die's defect map, not its serial. The serial is only a weak hint; the fuse
masks you read in Part 4a are what decide. From the community's reported scans, a small self-selected
sample, rough ballparks only:

- **SM count.** Nearly every 8GB card meets or beats the A100's 108 SMs after unlock. A third to a half
  come up near-pristine at 124 to 128; most of the rest land 108 to 124 with one defective GPC or a few
  defective TPCs; a small fraction are capped near 108. Stock, before unlock, they run 70 to 74.
- **Memory.** On the 8GB SKU the large majority unlock to 80 GB; a minority cap at 64 GB from a defective
  HBM stack; 96 GB is rare and needs the sixth stack populated. The 10GB SKU unlocks to 40 GB.
- **Leakage is the tell for a bad re-enable.** A card that idles at 75 to 89 W instead of 37 to 40 W has
  a leaky re-enabled block; back it out. Check per-GPC diode temperatures after enabling GPCs, since a
  marginal one runs hot.
- **PCIe lane defects are rare** but real (`OPT_PCIE_LANE_DEFECTIVE`); most cards read 0.

The only reliable statement for your card is the one you read from its own fuses.

## Part 5: flash the A100 VBIOS

The fuses set the physical resources; the VBIOS holds the VF table, the memory-per-stack config, and the
capabilities (ARI, LTR, SR-IOV) the card advertises.

1. Burn the A100 DEVID first (Part 4). A burned A100 DEVID will not POST on the old CMP VBIOS, so the
   card appears unbootable until you flash; this is expected, not a brick, and `nvflashk` still reaches
   it over the EEPROM path even when the driver cannot attach.
2. Cross-flash with `nvflashk`; the stock vendor `nvflash` cannot cross-flash a different board id. One
   card in the machine is simplest:

```
sudo ./nvflashk --protectoff
sudo ./nvflashk -i<index> -6 ./a100.rom      # -6 is the fixed override flag; confirm the prompts
```

3. Use the A100 PCIe VBIOS that matches your capacity (the HPE A100 40GB or 80GB updater images extract
   cleanly). Keep your stock VBIOS dump; it is the recovery path.
4. Changing DEVIDA and DEVIDB alone is not enough: the SS0/SS1 compute override must already be set from
   the burn, or the A100 VBIOS will not run compute. The A100 40GB VBIOS is the strict case; operators
   report it refusing to boot on a DEVID swap alone (even swapping IDA and IDB), because the VBIOS
   selects which id it reads, so land the SS0/SS1 IFF or burn before you expect the flash to POST. After
   a successful rebrand the memory clock behaves differently from the CMP VBIOS; see the overclock note
   in Part 6.

## Part 6: driver and runtime features

Each feature gives a volatile runtime path (host BAR0 writes, lost on a power cycle, for testing or a
driverless overlay) and points to its permanent fuse burn in Part 4. Offsets are BAR0.

- **Driver choice.** cmpunlocker patched modules (the SEC2-ROP and host path), the stock A100 driver once
  rebranded, or Zagitta's clean-room unlocker (unmodified drivers, caps idle near 23 W). Build with
  `iomem=relaxed`. On Windows the vGPU host driver package gives a working WDDM driver; Linux graphics
  performance is near zero (the throttle blacklists are not located yet).
- **Compute (full SM and tensor rate).** Volatile override, survives FLR, cleared by SBR:

```
0x00823804  FEAT_OVR_PLM         0xffffff8f -> 0xffffffff   (FUSE_QUADRO_WR_SEC 0x0082038c = 1 permits this)
0x0082381C  FEAT_OVR_SM_SPD SS0   write 0x88888888          (170HX 0x51261070 / A100 0x10413004)
0x00823820  FEAT_OVR_SM_SPD_1 SS1 write 0x00000008          (170HX 0x02 / A100 0x04)
0x00823818  FEAT_READOUT_1        reads 0x00000000 unlocked (0x016db6ed throttled)
```

  Permanent path is the speed-throttle FF clears (Part 4 rows 308 and 324). The OTP speed-select fuses
  stay throttled but `FEAT_OVR` supersedes them: `SS_DP 0x00820224` (FP64), `SS_FFMA 0x0082059C`,
  `SS_FMLA16 0x008207D4`, `SS_FMLA32 0x008207D8`, `SS_IMLA0..4 0x008207DC/E0/E4/E8/EC` (0x5 is 1/32 rate,
  A100 0x0). Never force `FEAT_OVR_QUADRO 0x00823808 = 0xffffffff` (booter 0x29).
- **Memory geometry (to 40, 64 or 80 GB).** Volatile (does not survive FLR; GSP rewrites it from fuses
  each boot):

```
0x009a0148  FBPA PLM             -> 0xffffffff
0x009a0204  FBPA_CFG1 broadcast  0x02449000 stock -> 0x02779000 (64/80GB) / 0x02669000 (40GB)
0x00100ce0  MMU_LMR              0x208/0x288 stock -> 0x0000020B (64GB) / 0x0000028A (40GB)
0x009a020c  CSTATUS_RAMAMOUNT    verify per-FBPA 0x200 -> 0x800 (40GB) / 0x1000; floorswept reads 0xbadf20xx
0x00100800  FBHUB_NUM_ACTIVE_LTCS  16 (8GB) / 20 (A100)
```

  A driverless overlay must write all 24 per-FBPA CFG1 at `0x00900204 + n*0x4000`. Permanent path is the
  FBP/FBPA/FBIO/ROP_L2 floorsweep FF records (Part 4) plus a matching-capacity VBIOS.
- **PCIe width (x16).** AC-coupling caps sit two per TX lane, so x4 needs 8 and x16 needs 32. The card
  ships about 8 populated (x4); solder the other 24 (220 nF 0402, in the C1100 to C1350 range) for x16,
  where one bad cap drops the link. `OPT_PCIE_LANE_DISABLE 0x00820394 = 0` confirms width is a board
  issue, not a fuse; a nonzero `OPT_PCIE_LANE_DEFECTIVE 0x008205E4` (rare) caps width in silicon.
- **PCIe speed.** Set by the three PCIe FF burns (Part 4), then read:

```
0x000880a4  LnkCap2 (RO)      0x1/0x3/0x7/0xF = Gen1/2/3/4 (cumulative)
0x00088088  LnkSta            link speed = (value >> 16) & 0xF
0x0008c1c0  PL_LINK_RATE      current gen in [23:20]
0x00088610  RESIZE_BAR1_CTRL  0x00001001 stock; clear bit 12, set bit 0 for ReBAR
```

  The `LnkCap2` latch is set once per cold power-on by the FSP ROM from `OPT_PCIE_BOOT_GEN3_DISABLE
  0x00820580`, before any firmware, so only the fuse burn plus a cold boot lifts it (Part 8, Gen3
  contested); runtime link-rate overrides do not stick.
- **DRAM ECC (HBM sideband, keeps full capacity).** Applied per boot by the SEC2-requester set (the two
  globals are host-write-masked, so they must come from a SEC2 requester):

```
per live FBPA (+ n*0x4000):  ECC_CTRL 0x009a0470 |= 0x41   (MASTER_EN bit 0 | SIDEBAND_EN bit 6)
                             +0x1004 |= 0x200    +0x33c |= 0x3    +0x084 |= 0x1
globals:                     0x0017e318 |= 1     0x0017e21c |= 1
```

  Sideband keeps full capacity and leaves `LMR 0x00100ce0` bit 30 clear; `SIDEBAND_EN` at boot sets
  sideband (full) versus inline (a ~1/16 carve). Permanent path is the `OPT_ECC_EN 0x00820228` column
  burn (rows 6/7 bit 28) plus the row remapper (rows 48/49 bit 5). Keep ECC on under memory overclock: it
  catches the silent marginal-cell DED that appears above about 93C with no Xid.
- **SRAM ECC (on-die: L2, SM, L1, register file, microcontrollers, PCIe).** Through the feature-override
  ECC units:

```
0x00823800  FEAT_OVR_ECC_PLM  0xffffff8f -> 0xffffffff
0x0082380c  FEAT_OVR_ECC      = 0x00999999
0x00823810  FEAT_OVR_ECC_1    = 0x003ffebf
0x0082382c  FEAT_OVR_ECC_2    = 0xf
```

  When on, `nvidia-smi` reports the SRAM SEC/DED counters by source. It costs almost nothing.
- **InfoROM (the ECC-counter and row-remap store).** `nvidia-smi` shows no ECC counters, and the row
  remapper has no backing store, without an A100 InfoROM and BIT-registry graft (CPU-RM only). `nvflash`
  refuses to write the A100 InfoROM over the 170HX one (`ID mismatch ... Device ID 0x20B5 vs 0x20C2`), so
  the first graft is forced with an external SPI programmer or a pre-graft (BRD) image; after that it
  flashes normally. Protection runs with or without it; the graft only restores visibility.
- **MIG.** Full profiles with a balanced TPC topology, no GRID driver:

```
1g.5gb x7 | 2g.10gb x3 | 3g.20gb x2 | 4g.20gb x1 | 7g.40gb x1
nvidia-smi mig -cgi <profile> -cci
```

  The "fails the TPC-per-GPC check" reports were unbalanced floorsweeps, not a hard wall.
- **vGPU.** A patched vGPU host driver package drives it and gives WDDM graphics on Windows (about 3060
  to 3070 class), which a retail A100 cannot do. GRID drivers come from the vGPU archive (end of guide).
- **SR-IOV.** The A100 VBIOS advertises ARI and LTR; the vGPU host driver exposes the VFs and the open
  GeForce-SRIOV project (`sriov-manage` / `sriov_numvfs`) drives them: set `iommu=pt`, then
  `sriov-manage -e <bdf>`. vGPU and WDDM are reported working; VFs on a rebranded 170HX are still to
  verify end to end.
- **Power states and idle.** Not fuses: ELPG, clock gating, P-states and the GC6 island ship
  unconfigured, so the card idles near 40 W instead of 15 to 25 W. Inject A100 or A30 P-states (into the
  VBIOS or through the driver) for 23 to 30 W. A fresh A100 flash can pin P0 and read a phantom ~20% load
  at about 72 W while idle; `nvtop` shows the real power, so trust it and inject P-states. GC6 deep idle
  wipes VRAM, so for a resident-model server use P-state injection plus ELPG and clock gating, not GC6;
  skipping `PMC_ELPG_ENABLE` or `HOLD_LTSSM` is a brick risk.
- **Overclock.** VF curve, TDP and clocks unlock via a VBIOS GSP override at ROM offset `0x46F77`
  (`00 00 00 00` to `18 FC E8 03`, plus or minus 1000 MHz), or by substituting the modified VBIOS through
  the driver registry without flashing. Memory-clock OC (working): multicast `0x0098bc98`,
  `mclk = 27 MHz * N`, coeff `M[7:0] N[15:8] P[23:16]`, stock `0x00014001` (1728 MHz) to `0x00014601`
  (1890 MHz, about 1782 GB/s); PLL write-gate `0x009a3c7c` bit 4, must land post-GSP. More SMs cut
  core-OC headroom (`XID 175` above about a 150 MHz offset); hard HBM OC leans on DRAM ECC, and `CCDL=3`
  HBM timing hard-hangs the card.
- **Memory clock after the A100 rebrand.** The register path above is the one that works. The
  CMP-era mem-clock tooling (cmpunlocker `170tune`, the `--mclk-ndiv` option) does not drive the A100
  VBIOS once you have rebranded; operators hit a "memory clock source" error and the option is not in the
  repo. On the A100 VBIOS the driver mod reaches the memory clock and the power limits only, through this
  NDIV register, not through the old tool. The HBM runs an effectively fixed clock besides: it does not
  train at a low enough voltage to save idle power, so do not expect a memory downclock for efficiency.
  Keep the HBM cool: below about 90 C the stray bit noise is ECC-corrected, and real errors start above
  93 C regardless of the clock you set.

## Part 7: verify

| Check | Command or register | Expected |
|---|---|---|
| Identity, memory, gen | `nvidia-smi` | A100 name if rebranded, full memory, negotiated gen |
| Compute unlocked | `FEAT_READOUT_1 0x00823818` | `0x00000000` (throttled reads `0x016db6ed`) |
| SM count | CUDA `deviceQuery` or OpenCL | matches the GPCs and TPCs you enabled |
| Memory size | `CSTATUS_RAMAMOUNT 0x009a020c` per-FBPA | `0x800` (40GB) or `0x1000`; `0xbadf20xx` is floorswept |
| PCIe gen, width | `LnkSta 0x00088088`, `LnkCap2 0x000880a4` | target gen; full width when trained |
| DRAM ECC | `ECC_CTRL 0x009a0470` bit 6, then memory stress | `SIDEBAND_EN` set; counters move on the error path |
| SRAM ECC | `nvidia-smi` SRAM counters | SEC/DED present by source |
| Thermals, leakage | per-GPC diode temps, idle power | idle about 37 to 40 W; a leaky re-enabled block runs hot |
| Stability | a real GEMM and bandwidth test at target clocks | clean under load |

## Part 8: common problems and fixes

**Never write these (permanent, confirmed dead cards):**

- `FEAT_OVR_ROW_REMAP 0x00823824 = 3` (0b11, reproduced twice).
- The full `FEAT_OVR_QUADRO 0x00823808 = 0xffffffff` mask (booter 0x29; cleared only by a driver
  code-revert and rebuild, not by FLR or SBR).
- All-ones into fuse rows 0 or 1.
- Any RIR write (`DEBUGCTRL` bit 1, RWL set) without verifying the exact row and bit for your die
  (Part 3). The four historical bricks were all RIR errors: wrong macro forcing `DIS_PROGRAM=1`, a RIR
  re-read loop, a stuck `RWL=1` on an 8GB card, and an incomplete FBPA write that hung GFW.

**GFW wedged at 0x1 (the common post-burn brick).** lspci shows the A100 but the driver cannot attach;
`GFW_BOOT 0x00118234` reads `0x1` instead of `0x3FF` (clean POST), often with `0 BAR` or `devinit`
errors and FB not trained (`LMR 0x00100ce0 = 0`). Usually a bad geometry FF (a defective unit enabled),
a DEVID/VBIOS/InfoROM mismatch, or no true cold cycle.

Read `0x1` carefully before you treat it as a brick. `GFW_BOOT = 0x1` is FWSEC's marker for a failed
secure-boot step, which it writes on any failing run, including on a fully POSTed card with live FB. It
is not proof that the card is un-POSTed or cannot be re-glitched: the diagnostic value is whether FB
trained and whether BAR0 and the fuse path still respond, not the `0x1` by itself. Confirm the wedge
with the FB and BAR symptoms above before spending rows on a revert. Recover if you kept a pre-glitch
dump and have free rows:

1. Re-glitch, then undo the wrong burns one at a time with higher-address FF records (last write wins),
   the PCIe writes first, then the FBP writes.
2. Watch the GFW canary or init error move forward each step; one recovery took about 70 rows over three
   days.
3. If it is a DEVID/VBIOS mismatch, flash the matching VBIOS, or flash the CMP VBIOS back and revert
   DEVID with a later FF record.

**Symptom table:**

| Symptom | Cause | Fix |
|---|---|---|
| DSOV 0 but no privilege (`0xfffffefe`, CRC `0x00`) | near-miss glitch | power-cycle out, sweep the in-window single pulse (Part 2a) |
| Re-glitch fails after a burn | expected | plan and burn the whole set in one session |
| A bad FF value | last write wins | supersede with a later FF record while rows remain (a bad RIR or column write can cost the row or brick) |
| `0 BAR` or `devinit` error after a burn | bad geometry or a mismatch | revert the burn (GFW recovery above) |
| Card drops off the bus mid-glitch | glitch too hard, no final reset | restore the VRM, one PEX reset, recheck BAR0 and CRC |
| Booter error `0x15` | degraded HS write engine | clears on SBR, not FLR; one fire per SBR |
| Booter error `0x29` | HS ECC write or a forced FEAT_OVR mask | driver code-revert and rebuild (FLR and SBR both fail) |
| Stuck `RWL=1` or wedged fuse macro | poking the RIR macro on an 8GB card | a power cycle usually clears a non-burned stuck RWL |
| Hangs in BIOS after the rebrand | no Above-4G or ReBAR | enable them, or move to a board that has them |
| Works elsewhere, not on this host | PLX warm-reset on the ports | watch for it on Intel PLX backplanes |
| No POST after a VBIOS flash | bad or mismatched ROM | reflash stock with `nvflashk` over the same interface; unrecoverable if the DEVID matches no bootable VBIOS |
| `NV_ERR_RESET_REQUIRED` hard hang | HBM timing `CCDL=3` | reboot |

**What each reset clears:**

| Reset | Clears | Does not clear |
|---|---|---|
| FLR | little | LnkCap2 latch, booter errors, FEAT_OVR island |
| SBR | HS write engine, booter `0x15` | the FSP power-on fuse latch |
| Cold power (PSU off, unplugged, rails drained) | glitched state, FSP latch, XVE errors | this is the full reset |

An OS reboot is none of these, and `nvidia-smi -r` is unsupported on this card; `XVE` errors specifically
need a full unplug, not a power-off.

**Two more cautions:**

- **Do not trust fuse names.** Some named like "SKU recovery" only make things worse; burn on a verified
  effect, not the name.
- **`OPT_TITAN_EN` is not a step.** One unreplicated report on a broken VRM; treat it as unsafe.

## What stays blocked

- **10-bit PCIe tags.** `OPT_XVE_10B_TAG_REQUESTER_DISABLE` has no undo bit. Unfixable for now; Gen4
  trains anyway, so this is non-blocking.
- **96 GB.** HBM site E is unpopulated on these cards and FBP 6 and 11 are fused defective; 64 or 80 GB
  is the ceiling.
- **NVENC, display, RT cores.** Absent from the GA100 die. NVDEC, NVJPG and OFA are the media capability
  that exists.
- **Half-stack bandwidth.** The four half stacks do not deliver full bandwidth; a hardware limit, not a
  fuse.
- **NVIDIA Remote Attestation (NRAS).** A glitched card can never pass it; Confidential Compute
  (secure boot, signed attestation, the BAR0 PCIe firewall) is out of reach. This matters for any buyer
  who needs attested hardware.
- **Gen3 and Gen4, contested.** This guide's map reaches Gen4 by burning the three PCIe FF records, and
  server cards report Gen4 x16 around 24 GB/s. A dissenting analysis holds that `OPT_DISABLE_GEN3_SPEED`
  sets the PCIe LnkCap2 latch once per cold boot in the FSP mask ROM, before any firmware runs, so no
  post-boot override can lift it and only the permanent fuse burn (which the FSP reads at the next cold
  boot) can. Both agree on the practical rule: burn the fuses, then full cold boot; a runtime register
  override of the link speed is a dead end.
- **NVLink needs the bridge and a refclk.** The silicon unlock is one FF record; a working link needs
  the physical bridge path and a reference clock, which is hardware the stock card does not carry. The
  refclk is the crux, and there are three ways to supply it, one per card pair. Bridge the `U11` pins on
  the card with a solder bridge; or set the NVLink refclk to the PCIe clock (`refclk = pcie`), in which
  case `U11` does not need bridging as long as a refclk is present somehow; or feed an external
  156.25 MHz reference. The clock-gen chip on a consumer NVLink bridge is not required on these GA100
  dies: the serdes sampler runs off clock-data recovery, and NVIDIA fits the clock-gen only to cover
  consumer boards on unsynced PCIe clocks. Partial bridging is fine: a link with no bridge parks in
  RXDET and needs no link mask, so you can bridge only the pairs you use. A bridge can be bought (NVIDIA
  2-slot and 3-slot, a rare 4-slot for the 3090 line, or a Chinese clone) or fabbed: the pin traces are
  straightforward to replicate on a board from JLCPCB or similar, and the connectors, not the PCB, are
  the cost (roughly a thousand for connectors against a few hundred for ten boards). P2P across two
  cards on separate CPU root complexes can kernel-panic the host, so keep a P2P pair on one root complex.

## Software and references

Third-party community code, offered as pointers. Read before you run, and run only against a card you
mean to modify.

```
Glitch rig and firmware (8GB SKU)
  kate.land ga100vfi       github.com/kate-land/ga100vfi            the original research toolchain
  dalzyyy pico-ga100vfi    github.com/dalzyu/pico-ga100vfi          Pico 2 tool with feedback + state verify (recommended start)
  rp2040-glitch-tool       github.com/JosiahWhite/rp2040-glitch-tool  RP2040 USB-CDC I2C glitch firmware
  mello glitch-loop        gist.github.com/JosiahWhite/ab0b13461af4e1716e79ac629755642c  drive-to-FF-writable loop
  gpu-unlock               github.com/Zagitta/gpu-unlock            pico glitch firmware; 3.0.0-beta clean-room unlocker (~23 W idle)
  wake-and-break           github.com/blasty/wake-and-break         glitch tooling

Fuse / FF / floorsweep
  cmp170hx-ffcalc          github.com/sayhellotojungle/cmp170hx-ffcalc  FF-record calculator (feature to FF word)
  ff_calc / ff_burn        community Discord archive (ff_burn.zip)   recipe-driven FF calculator + burner, 8GB glitched cards
  gpcprobe                 github.com/matstatman/gpcprobe           GPC / floorsweep reader
  nvidia-asic-quality      github.com/Panchovix/nvidia-asic-quality defect / ASIC-quality reader
  cmpunlocker              github.com/asm64-hooligan/cmpunlocker     the software (SEC2-ROP/host) unlocker and driver path

Flash
  nvflashk                 github.com/y0usaf/nvflashk-linux          cross-flash / board-id bypass (Windows docs: TechPowerUp thread 312608)
  nv-uefi-unlocker         github.com/physicsdolphin/nv-uefi-unlocker  UEFI-side Above-4G / ReBAR unlocker

Drivers / features
  open-gpu-kernel-modules  github.com/aikitoria/open-gpu-kernel-modules (610.57.04-p2p-v3)  BAR1 P2P for GA100
  vGPU driver archive      nvidiavgpuarchive.github.io               GRID / vGPU host drivers (enables WDDM on Windows)
  GeForce-SRIOV            reddit r/VFIO "geforcesriov"              SR-IOV / vGPU enablement writeup

VBIOS
  A100 PCIe VBIOS          HPE A100 40GB / 80GB updater images extract cleanly; TechPowerUp VGA BIOS collection

Theory and reference
  the glitch write-up      blog.kate.land/posts/using-voltage-glitching-to-unlock-the-a100/
  silicon lottery          deced.github.io/CMP-170HX-GAMBLE/
```

**On the FF planner.** The community `ff_calc` / `ff_burn` pair is a useful way to inventory a card and
compute its per-card FF map: `ff_calc.py --recipe all` reads the card and writes an `ff_calc_<serial>.txt`
with the calculations and FF records for the features it knows; `ff_burn.py <that file>` dry-runs, and
`--yes-burn` writes, taking a card already in Goldilocks and running the re-sense itself, or a card
re-sensed beforehand. It is good for finding where your own plan has the wrong bits. Treat its output as
a calculator result, never an authority: its author warns that mistakes may exist, that parts of a
sample recipe carry card-specific trimcodes that must not be copied, and that you must verify each record
by hand under both layouts (Part 3) before you burn. SW-IFF-test the whole plan first.

## Provenance and limits

Built 2026-11-18, extended 2026-11-19, and extended again 2026-11-20, compiled from the published,
read-back-verified work of independent researchers and cross-checked against a reconciled GA100 register
map and a verified ordered burn sequence (over 20,000 messages across 14 technical channels). The
2026-11-20 pass worked the existing corpus plus a first-hand operator field report (it was not a fresh
harvest): the Goldilocks confirm registers and the pre-burn re-sense, the card-dependence of
re-glitching and the true meaning of `GFW_BOOT = 0x1`, the memory-clock behavior after the A100 rebrand,
the NVLink refclk and solder-bridge options, and a note on the community FF planner. Addresses, offsets and record values
are included only where sources agree; where they differ, the read-back-verified value is used and the
alternative noted. The floorsweep and identity records are card-specific and must be derived per die,
not copied. The authors have not reproduced the full process end to end, so verify every value on your
own hardware before burning. Leak-derived secret and key material is deliberately excluded. Provided for
research and education, as-is, with no warranty.
