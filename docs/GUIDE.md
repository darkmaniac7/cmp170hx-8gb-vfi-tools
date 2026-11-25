# CMP 170HX 8 GB, start to finish: before, during and after the glitch

This guide takes one CMP 170HX 8 GB card (`10de:20c2`) from a stock mining card to a card with more SMs, the 80 GB
memory layout and a PCIe Gen4 link, in the order the lab did it on seven cards in November 2026. It puts in one place
what is spread over this repository and over [cmp.wiki](https://cmp.wiki), and links the long pages instead of
copying them. Cards are named by their letter on the cmp.wiki
[results page](https://cmp.wiki/wiki/Voltage-glitch_unlock:_lab_results_and_fuse_findings). The hosts are the lab's
bench (an Intel Core i9-13900K desktop) and the lab's EPYC server (dual-socket AMD EPYC, eight cards).

The work has three phases. **Before the glitch** you check that the card is worth it, build the bench, flash the
firmware, take a cold baseline and write the whole burn plan. **The glitch** is the search for one "goldilocks" boot
in which the fuse that blocks the software override reads open; this repository runs that search. **After the
glitch** you burn the planned records with your own tool, verify them after a cold boot, and then make the driver
use them: 80 GB, more SMs, Gen3 and Gen4. Each glitch by itself changes nothing permanent; the records you burn do.

What the lab's cards ended up with, every value read after a cold boot:

| Card | SMs before | SMs after (with the RECONFIG override) | SM ceiling | Memory | Cold link capability | FF records |
|---|---|---|---|---|---|---|
| A | 70 | 122 (126) | 126 | 80 GB layout, 81920 MiB under the 80 GB driver | 16 GT/s x16 | 14, then the GEN23 record |
| B | 70 | 120 (124) | 124 | 80 GB layout, 81920 MiB | 16 GT/s x16 | 16, then the GEN23 record |
| C | 70 | 120 (124) | 124 | 80 GB layout, 81920 MiB | 16 GT/s x16 | 15, GEN23 included |
| D | did not enumerate | | 128 | | | none: no core rail, a board repair |
| E | 70 | 106 (110) | 110 | 80 GB layout (FBP disable `0x09`), 81920 MiB | 16 GT/s x16 | 14, GEN23 included |
| F | 70 | 108 (112) | 112 | 80 GB layout, 81920 MiB | 16 GT/s x16 | 15, then the GEN23 record |
| G | 70 | 122 (126) | 126 | 80 GB layout, 81920 MiB | 16 GT/s x16 | 15, then the GEN23 record |
| H | 70 | 118 (122) | 122 | 80 GB layout (FBP disable `0x24`), 81920 MiB | 16 GT/s x16 | 16, then the GEN23 record |

"Before" is the fuse floor of every stock 8 GB card: 70 SMs (74 with cmpunlocker's override) and 64 GB. The SM
ceiling counts the TPCs not marked defective. On the lab's EPYC server five of these cards train Gen4 x16 at every
boot; the other two sit in slots where the guard turned the Gen4 step off during testing, and run at Gen3
([section 4.4](#44-pcie-gen2-gen3-gen4)).

> **This repository glitches and reads. It never burns.** No tool here senses, arms or burns fuses, and no burn tool,
> burn planner or per-card plan is included. FF records are permanent, and a wrong record can brick a card. The lab
> burned with the burn tool of [cmp170hx-ffcalc](https://cmp.wiki/wiki/Cmp170hx-ffcalc)
> (sayhellotojungle/cmp170hx-ffcalc), with the fixes listed on that wiki page, from per-card plans made by its own
> planner, which is not public. You probe a powered board with needles and pull its reset line; a slipped probe can
> damage the card or the host. Read [Unlock without bricking](https://cmp.wiki/wiki/Unlock_without_bricking) before
> you start. Use at your own risk.

Contents:

1. [Before the glitch](#1-before-the-glitch)
2. [The glitch](#2-the-glitch)
3. [At the goldilocks](#3-at-the-goldilocks)
4. [After the glitch](#4-after-the-glitch)
5. [Troubleshooting](#5-troubleshooting)
6. [Where to read more](#6-where-to-read-more)

## 1. Before the glitch

### 1.1 Is your card a candidate

- **The device ID must be `10de:20c2`** (`lspci -nn`). The 10 GB card is `10de:2082` and opens with an RIR burn and no
  glitch ([RIR fuse burn](https://cmp.wiki/wiki/RIR_fuse_burn)); nothing in this guide applies to it.
- **Read the floorsweep first.** On a cold boot with no driver bound, `tools/vfi_snap.py` (BAR0 reads only) prints
  the GPC and FBP disable and defective masks, `SM now` and the SM `ceiling`, and the PCIe option words.
  [gpcprobe](https://cmp.wiki/wiki/Gpcprobe) (@matstatman) reads the same fuses with the driver bound, and
  cmp170hx-ffcalc has a read-only scan that predicts SM count and 64 or 80 GB.

| What the read shows | On a typical stock card | What it means |
|---|---|---|
| `SM now` | 70 | the fuse floor; 74 with cmpunlocker's RECONFIG override |
| SM ceiling | 110 to 128 on the lab's cards | the most compute can reach: GPCs and TPCs marked defective stay off. A whole defective GPC costs 16 SMs (card F, GPC 7: ceiling 112) |
| FBPs off | 4 of 12: 2 marked defective, 2 disabled without a defect flag | the 2 gated FBPs can come back: 10 of 12, the 80 GB layout. Most cards: FBPs 6 and 11 defective, 1 and 4 gated (FBP disable `0x852`, `0x840` after the burn) |
| FBPs marked defective | 2 | 4 marked defective means the card stays at 64 GB whatever you burn |
| PCIe option words | `PCIE_MAGIC_BITS_D` `0x16680000`, both Gen3 disables 1 | normal at stock; the PCIe records clear them |

- **"Dud" 64 GB cards.** Some cards have four FBPs marked defective, not two. "Defective labelled FBPAs are simply not
  coming back" (@meatsus), so such a card tops out at 64 GB; it can still gain SMs and PCIe. Members reported about
  one such card per batch of 4 to 8 (estimates of 0.1 to 0.2 per card, contested). Ask for a read before you buy:
  [8 GB compute and HBM](https://cmp.wiki/wiki/8_GB_compute_and_HBM:_limits_and_open_questions),
  [Floorsweep read of the 8 GB card](https://cmp.wiki/wiki/Floorsweep_read_of_the_8_GB_card:_gated_versus_defective_partitions).
- **Never plan to enable a unit marked defective.** "If it is marked as defective, do not enable it"
  (@petrikrohn_26497); enabling defective FBPs is the biggest brick risk named on the wiki. The masks also differ per
  card: the lab's cards E and H ended with FBP disable `0x09` and `0x24`, not the `0x840` of the others.
- **Count the blank FF rows.** Members found 160 to 196 on most cards and 37 on one new card. Every record and every
  later fix spends a row.
- **Check the card is alive.** Card D never enumerated: the MP2888B did not answer at I2C address `0x25` and NVVDD read
  0.016 V with 12 V present. That is a board repair, not a glitch problem. A healthy card idles NVVDD at about 0.7 V.
- **Expect some cards to fight.** One member estimates that about 20 percent of cards do not reach goldilocks with the
  public Pico tool. The lab's cards C and E took about 4,000 and more than 3,000 shots before a new approach finished
  them (section 2.8).

### 1.2 Hardware

The lab's parts, with no soldering
([parts and host](https://cmp.wiki/wiki/Voltage-glitch_unlock:_lab_method_on_a_Pico_2_W)):

- **The glitch controller:** a Raspberry Pi Pico 2 W class board (RP2350). The lab used a Freenove Pico 2 W with
  headers (RP2350A). The patches here build for `pico2_w` (RP2350A and RP2350B) and `pico2`.
- **Contacts:** four spring needles in hands-free holders (a SensePeek PCBite kit with SP10 probes) and Dupont leads
  to the Pico header. Short soldered leads work too; whoever solders them also has to take them off again.
- **Checks:** a multimeter, and a USB microscope to see each needle seated in its via.
- **Cooling:** a blower fan along the fins, to hold the card at a steady temperature.
- **Optional:** a fifth needle on NVVDD, for the debug build's ADC trace (section 2.7).

All points are tinned vias on the back of the PCB; the heatsink stays on.

| Pico (RP2350A) | Card point | Check with the host on and the lead loose |
|---|---|---|
| GP0 (I2C0 SDA) | I2CC_3V3_SDA: the via just right of Q808's top-right pin | about 3.3 V |
| GP1 (I2C0 SCL) | I2CC_3V3_SCL: the via just below Q808's bottom-left pin | about 3.3 V |
| GP22 | PEX_RST_BUF*: the via just right of the "U809" silkscreen | about 1.8 V |
| GND | a gold mounting-hole ring, or a clip on the bracket | beeps to the bracket with the power off |
| GP26 (optional, debug build; GP42 on RP2350B) | NVVDD: one end of a core-rail bulk capacitor marked 470 | about 0.7 V at idle |

- **Wire by the GP labels printed on your board.** A pinout read from the back mirrors the two sides; on the lab's
  bench SDA and SCL once landed on VBUS and VSYS, and the I2C preflight caught it.
- **PEX_RST is a 1.8 V push-pull net.** Use a direct lead with no series resistor. The firmware only pulls it low and
  releases it; never drive it high.
- **Flash the Pico before any lead touches PEX_RST** (section 1.6).
- **Order, host off for every probe move:** ground, SDA and SCL first; power on and run the I2C preflight; power off;
  PEX_RST last. At the end, lift PEX_RST first.
- **Check before power.** With the power off, ground to the bracket must beep and SDA, SCL and PEX_RST to ground must
  not. With the host on and the leads loose, measure 3.3, 3.3 and 1.8 V. A wrong voltage means a wrong via: stop.
- Neighbouring vias are about 1 mm apart. Fix the card so it cannot slide, and do not bump the bench during a run.
- Wire the ground: one member's rig "was very flacky" until he did.

### 1.3 The x16 capacitor mod

The card leaves the factory training x4: the AC-coupling capacitors of lanes 4 to 15 were never fitted. The
[PCIe x16 capacitor mod](https://cmp.wiki/wiki/PCIe_x16_capacitor_mod) adds the 24 missing 0402 220 nF capacitors
(100 nF failed to retrain for one member). It changes link width only; generation is a driver matter.

- **The glitch does not need it.** The lab glitched with the link at Gen1 x8 on a riser; members say x1 is enough.
- **Gen3 and Gen4 bandwidth does.** All seven of the lab's finished cards had the mod. At Gen4 x16 a card moves 22.4
  to 25.1 GB/s on the lab's EPYC server; card B, on a riser at x8, moved 12.24 and 13.52 GB/s at Gen4.
- **Do it and verify it before the glitch**, with `LnkSta` (never `LnkCap`, which shows x16 on a stock card).
- **Check the width again at Gen4.** Members saw cards that held x16 at Gen2 drop to x8 at Gen4 after the unlock;
  the fix was the solder joints. x8 after the mod means a bad joint, not a hardware limit.

### 1.4 Risers, slots and bifurcation

- **For the glitch, any link that enumerates will do.** The lab's bench ran the card flat on a SlimSAS riser in a
  chipset slot, at Gen1 x8.
- **For Gen4 later, the path matters.** Prefer direct CPU lanes and short, good cables (one member's rule of thumb at
  PCIe 4: "50cm or less passive"). Some slots will not hold 16 GT/s: on the lab's EPYC server two different cards
  failed Gen4 in one slot, another slot logs correctable errors even at Gen3, and the cards there stay at Gen3.
- A retrain that ends at 2.5 GT/s "(downgraded)" points at the signal path (riser, cable or slot), not at settings.
- More: [Risers and bifurcation](https://cmp.wiki/wiki/Risers_and_bifurcation).

### 1.5 The bench host

The lab glitched on its bench: an Intel Z790 desktop board with a Core i9-13900K, on Linux. One member finished
his first card on an old Intel desktop after an AMD EPYC server fought him; another found an X99 board the most
stable of three. Whatever you use, you must be able to power cycle it:
every poison without the in-boot reset, every controller latch and every lost link on an already-burned card costs a
power cycle (1.5 to 2.5 minutes on the lab's bench). `cimp` drives Wake-on-LAN, IPMI, or you at the button
(`POWER=manual`).

Prepare the host before the first shot:

1. **Secure Boot off.** `/sys/kernel/security/lockdown` must show `[none]`. A BIOS update on the lab's board turned
   Secure Boot back on, and kernel lockdown then refused every BAR0 and `setpci` write ("direct PCI access is
   restricted").
2. **A glitch boot entry with no NVIDIA driver.** Bind `10de:20c2` to `pci-stub` (for example `options pci-stub
   ids=10de:20c2` in modprobe.d), blacklist `nvidia` and `nouveau` on that entry, and update the initramfs. A driver
   build that applies fuse overrides at probe time can write to a card whose DSOV reads 0. One member's driver stayed
   loaded because a remote-desktop server held the GPU.
3. **Boot with `pci=noaer`**, so AER recovery does not bus-reset the slot while the Pico resets the card many times.
4. **Memory decode on** for a cold card with no driver: `vfi_preflight.py --enable-decode`, or `setpci -s <bdf>
   COMMAND=0x0002`. That write is not a link retrain.
5. **A venv with the patched host package** (section 1.6), and ssh by key from the machine that runs `cimp`.

Intel root complexes retry a config read forever when a half-booted card answers with CRS: the lab's bench froze
three times that way, each time on a config read right after handing the rail back. The tools park the card before
any config read (section 2.5); do not add your own config reads between shots.

### 1.6 Firmware and host package

```sh
git clone https://github.com/dalzyu/pico-ga100vfi && cd pico-ga100vfi
git checkout e1ebd97                       # the base the patches were made against
git am /path/to/cmp170hx-8gb-vfi-tools/firmware/*.patch
cmake -S firmware -B build -G Ninja -DPICO_BOARD=pico2_w -DBOARD_RP2350A=ON [-DDEBUG=ON] && cmake --build build
python3 -m venv ~/vfi-venv && ~/vfi-venv/bin/pip install ./host
```

- The lab built with pico-sdk 2.3.1 and the Arm GNU toolchain 14.2, with no warnings. One member's UF2 flashed but
  never showed a serial device: the cause was the SDK. Upstream's prebuilt images do not carry these patches.
- With all twelve patches the `v` status line shows `fw=lab-psr1-push3` (`-debug` on the debug build, which the
  NVVDD trace needs). push3 is the current firmware: a PMBus write may run across the reset release
  ([`PUSH3.md`](PUSH3.md)). The patches, one by one: [`firmware/README.md`](../firmware/README.md).
- **The BOOTSEL trap.** `picotool load -f` did not get a running board into the bootloader on the lab's bench. Hold
  BOOTSEL, unplug and replug the USB, release after a second, then `picotool load -v -x pwmvid.uf2`; if the board comes
  straight back as the bootloader, `picotool reboot`. Keep the previous image to roll back the same way.
- Patch `0001` restores each card's own VRM profile after every shot. Stock firmware writes back its author's table,
  and two of the lab's cards did not match it (`0xBA = 0x000E`, `0xB9 = 0x0039`, `0x31 = 0x1872`).

### 1.7 Baseline: preflight, cold snapshot, die ID

Run as root with the venv's Python, on a cold boot of the glitch entry:

```sh
export VFI_BDF=<bdf>            # lspci -Dn -d 10de:20c2
export VFI_PORT=<pico serial port>
PY=~/vfi-venv/bin/python
sudo -E $PY tools/vfi_preflight.py --bdf $VFI_BDF --enable-decode
sudo -E $PY tools/vfi_snap.py --rows --label cold-baseline       # keep this file private
```

- **Preflight** checks the firmware marker, who owns the rail, the six VRM profile registers (`0xBA`, `0xB9`, `0x30`,
  `0x31`, `0x32`, `0x45`; it stops on a leftover fast value, which means an interrupted shot: power the card fully
  off), kernel lockdown, the driver, config space, FUSECTRL and GFW boot progress.
- **The cold snapshot** must read DSOV 1, CRC `0x55` and `SM now` 70, and `--rows` reads the 512 fuse rows twice with
  READ commands only; the two passes must match. Plan only from this read. It identifies the card: mode 0600, never
  posted.
- **The die ID.** Fuse rows 8 to 15. Two of the lab's cards reported identical GPC masks, SM counts and ceilings, and
  only the die ID told them apart. Give the card's dump to `cimp` as `die_dump` (or `DIE_DUMP` in `bench.conf`), and
  every boot stops (exit 5) when the card in the slot is not the one the plan was made from. `vfi_snap.py --die-id
  DUMP` is the same check by hand; it prints row numbers, never values.
- **The release-timing gate.** Three fresh boots, one harmless 450 mV standard shot each; every one must report
  `release_at=0 scheduled=0 via=alarm`.
- **CiMP.** `./cimp config` describes the bench once (host, ssh, power control, Pico port, log directory, temperature
  band, cards); register the card from the snapshot (`card.<label>.gpc`, `card.<label>.smc`, and the plan files and
  `die_dump`), then `./cimp config --test` until every check is green ([`CIMP.md`](CIMP.md)).

### 1.8 Write the burn plan before the first shot

Plan every set you want, review it and dry-run it before the first glitch, so that one window is enough. Card A got
its compute records in its first window (11 shots); its memory and PCIe records needed a second window, about 1,200
shots over three boots. Cards B, C, E, F, G and H got all three sets in one window.

**What goes in.** Built from your own cold read, never from another card's plan:

- **Compute:** the TPC disable masks (chain 1 blocks 11 to 15), PES disable (blocks 15 to 17), and the GPC disable
  (block 8) last. Clear only what is not marked defective. The lab's cards took 6 or 7 records.
- **Memory:** five chain-1 records with the FBP record (block 19) last: FBIO, FBPA (two blocks), ROP_L2 and FBP. The
  records on the [results page](https://cmp.wiki/wiki/Voltage-glitch_unlock:_lab_results_and_fuse_findings) fit only
  cards whose blocks held the same old values; card H needed its own.
- **PCIe: all four link-speed fields, GEN23 included.** The lab's first burns left `OPT_PCIE_BOOT_GEN23_DIS` fused,
  and every one of those five cards needed a second glitch session just for that record. Cards C and E had it in
  their main burn.

| Field (shadow register) | Fuse location | Stock | After | Record on the lab's cards |
|---|---|---|---|---|
| `PCIE_MAGIC_BITS_D` (`0x820520`), bit 25 is the Gen4 disable | chain 2 block 47 bit 3 | `0x16680000` | `0x14680000` | block `0x0059` to `0x0051`: `0x00510BC2` |
| `OPT_PCIE_BOOT_GEN3_DIS` (`0x820580`) | chain 2 block 49 bit 7 | 1 | 0 | alone: block `0x00E4` to `0x0064`, `0x00640C42` (the lab's first burns) |
| `OPT_PCIE_BOOT_GEN23_DIS` (`0x82057C`) | chain 2 block 49 bit 6 | 1 | 0 | with GEN3_DIS: block `0x00E4` to `0x0024`, `0x00240C42`; the same word as a later extra record on a card at `0x0064` |
| `OPT_DISABLE_GEN3_SPEED` (`0x820250`) | chain 2 block 39 bit 9 | 1 | 0 | block `0x0782` to `0x0582`: `0x058209C2` (bit 1 does nothing for it) |

With GEN23 still fused a cold card advertises only 2.5 GT/s in `LnkCap`, the driver caps it at Gen2, and the Gen4 PHY
init halted the lab's EPYC server at write 7. With it cleared the cold card advertises 16 GT/s x16. The lab's GEN23
records sit in rows 307 to 331, a different row on every card.

**Rules the plan must pass:**

- An FF record is one 32-bit word, `data[31:16] | block[15:6] | chain[4:0]`, bit 5 clear. It replaces the whole
  16-bit block, and the last record for a block wins. Check every other bit of the block against your own read.
- Never write a word with bit 5 set inside the FF region: it ends the FF pool, and every later record is ignored.
- Check the exact 32-bit word your tool will write. A script bug that burned only the top half of each word left one
  member's card at x1 with no driver.
- Your planner must reproduce, from the existing FF rows, the masks the card reports live; otherwise it should refuse
  to plan. Keep a reserve of blank rows (the lab's planner keeps 16).
- Simulate the plan against the dump (the lab used ffcalc `simulate`: 0 errors). Members warned against running
  ffcalc's own plan unchecked: "please do not yolo ffcalc without doing your research first" (@lia_oc).
- Order: compute with the GPC record last, then memory with the FBP record last, then PCIe. The first record is the
  test row.
- Have someone else review it. "Two models agreeing isn't verification" (@galygious).
- Checksum the plan and the dump it was made from. `bootrun.sh` checks both on both machines every boot.

The full rules, with the brick reports behind them:
[Unlock without bricking](https://cmp.wiki/wiki/Unlock_without_bricking),
[Fuses and floorsweep maps](https://cmp.wiki/wiki/Fuses_and_floorsweep_maps).

### 1.9 Checklist before the first shot

- [ ] `10de:20c2`, floorsweep read, ceiling and 64 or 80 GB known, no defective unit in the plan
- [ ] Capacitor mod done and verified with `LnkSta`, or a decision to do it later
- [ ] Pico flashed with push3 (`fw=lab-psr1-push3`) before any lead touched PEX_RST
- [ ] Needles seated, continuity and voltage gates passed, ground wired, NVVDD lead decided
- [ ] Secure Boot off (`[none]`), glitch boot with no driver, `pci-stub`, `pci=noaer`, memory decode on
- [ ] Preflight clean, the six VRM profile registers read and saved
- [ ] Cold snapshot with two matching 512-row reads, kept private
- [ ] Burn plan with compute, memory and all four PCIe fields, simulated, reviewed, checksummed
- [ ] Die ID dump set for the card, so a wrong card stops at preflight
- [ ] Release-timing gate: three boots, every release at 0 µs by the alarm
- [ ] `./cimp config --test` all green, power control proven, a temperature band the room and fan can reach
- [ ] A way to burn that you trust, ready before the hold (this repository has none)

## 2. The glitch

### 2.1 What a shot does

The Pico takes the card's MP2888B voltage controller (I2C `0x25`) under PMBus control, holds the GPU in reset on
PEX_RST, releases it (t = 0) and dips the core rail (NVVDD) around the release, while the GPU senses its fuses. The
target is a boot in which DSOV (`0x820084`, the software-override disable) reads 0 while the rest of the fuse read is
intact. A power cycle undoes it.

Words used below: **s1** is when the first dip write starts, relative to the release (`t_dip - delay`); one PMBus
write takes about 47 µs. A **code** is one VID step of the controller, 6.25 mV. **fast 1** loads a fast slew profile
for the shot; **fast 0** keeps the card's own, slower slew. A **cell** is several shots at one setting.

### 2.2 CiMP: one command for the bench

`./cimp` drives the launcher, the runner and the hunter, shows the bench in plain words and stops with the card held
when a goldilocks appears. It is meant to be run by an LLM agent with a shell on your controller machine, and every
step also works by hand. You keep the physical work and every burn decision.

| Command | What it is for |
|---|---|
| `./cimp config`, `--test` | describe the bench once; read-only checks before every session |
| `./cimp hunt strategy` | the search order and the stop rules |
| `./cimp hunt <phase> --out plan.json` | plan one phase: `train`, `readmap`, `init`, `slow`, `dwell`, `overlap` |
| `./cimp hunt run plan.json --card <label>` | dry run; add `--execute` to power-cycle and shoot |
| `./cimp watch` | live panel: phase, temperature with a fan cue, every shot as a word, a bell on a hold |
| `./cimp hunt tally <run dir>` | the map per cell and the command for the next phase |
| `./cimp ladder`, `./cimp classify` | what each frame means; name every shot in a log |

- **With an agent:** it reads [`AGENTS.md`](../AGENTS.md) (the rules it never breaks, a first-session walk-through,
  the loop, exit codes, holds, troubleshooting), then [`AUTONOMOUS_AGENT.md`](AUTONOMOUS_AGENT.md). The README has a
  prompt to paste. It asks you for the fan and anything physical, and it never senses, arms or burns.
- **By hand:** the same commands, in the order of the README's "By hand" block. The runner and launchers without
  CiMP: [`RUNNER.md`](RUNNER.md). Every setting: [`CIMP.md`](CIMP.md).
- **Under the hood:** the hunter ([`tools/hunter/goldilocks_hunt.py`](../tools/hunter/goldilocks_hunt.py)) plans each
  phase and checks every step against the firmware's release rule; the launcher (`tools/runner/bootrun.sh`) runs one
  boot per call; the runner (`tools/runner/bisect_shots.py`) fires and classifies the shots on the bench; and
  [`tools/planner/`](../tools/planner/README.md) keeps a ledger of every shot and plans the next ones.

### 2.3 What guards every boot and every shot

Before a shot is fired: a fresh-boot guard (short uptime, a boot id that changed), the plan files' checksums on both
machines, the preflight, the card's identity (GPC and SM masks) and die ID, and a temperature gate. The first shot of
every boot is not scored. After every shot the runner wants:

- the release 0 to 4 µs after t = 0 by the alarm, with no write across it (otherwise **mistimed**: read, not scored);
- the dip really ran (`pwd=1`, `e1=0xc2fa`; a locked controller acknowledges dip writes and drops them);
- the controller on (no OFF bit in STATUS_WORD, READ_VOUT in range);
- FUSECTRL read first: on `0xBADFxxxx` or `0xBAD0xxxx` nothing else is read;
- the sentinel (`0x820410`) as at the start of the boot; sentinel 0 counts as poison only with DSOV 1 outside a stall
  read (a real goldilocks reads 0 there, and card G's first one was thrown away for it);
- a stall (GFW not `0xFF` after the wait) read once, read-only, never skipped.

After a lost shot the runner sends one 100 ms PEX_RST pulse and requires a healthy locked read (FUSECTRL idle, DSOV
1, CRC `0x55`, full mask, sentinel), or the boot ends. Each boot is capped (450 shots and 150 lost shots by default);
members report that nothing hits after about 500 shots on one boot. Never write DEBUGCTRL (`0x820060`), and no
secondary bus reset or `setpci` retrain during a campaign.

### 2.4 Reading a shot

| Frame | What the reads show | What it means |
|---|---|---|
| under | DSOV 1, CRC `0x55`, privilege mask `0xFFFFFFFF`, FUSECTRL idle `0xE0040000`, GFW `0xFF` | nothing reached the fuse read, or the GPU restarted its init cleanly. Go deeper or move s1 |
| compass | DSOV 1, full mask, CRC other than `0x55` | the fuse read moved, DSOV did not: a signal, densify here |
| stall with a block code | GFW `0x01` or `0x00`; CRC `0x57` block 0 failed, `0x75` block 2, `0x77` both | the dip caught a fuse block read; the code works as a clock |
| stall with sentinel 0 | GFW `0x00`, sentinel 0, CRC `0x55`, full mask, DSOV 1 | the init was disturbed, one step from the poison edge. Not poison |
| DSOV-0 stall | GFW stalled, DSOV 0, CRC `0x77`, full mask, sentinel 0 | very close: dwell. Card G hit on the next shot |
| CRC44 | DSOV 0, CRC `0x44`, full mask, often a completed boot | blocks 0 and 2 never checked. An active sense keeps CRC at `0x44`: not burnable |
| over, partial | DSOV 0 with CRC not `0x55`, or a mask such as `0xFFFFFEFE` | too deep or at the wrong time. Never sense it |
| **goldilocks** | **DSOV 0, CRC `0x55`, privilege mask `0xFFFFFFFF`**, FPF row readable; sentinel 0 is expected | the target: the run holds it (section 3) |
| lost | no link after the shot | the GPU dropped off. On a burned card the link latches (section 2.5) |
| poison | FUSECTRL or DSOV `0xBADFxxxx` (often `0xBADF510E`) | the dip corrupted the fuse read. Read nothing else |
| fuse unit error | FUSECTRL `0xBAD0xxxx` | the fuse unit did not answer; repeat the setting before believing it |
| latch (controller off) | STATUS_WORD `0x2042`, READ_VOUT about 41 mV | the MP2888B switched its output off: power cycle |
| nack | the controller did not answer on I2C | seen only at crash-prone settings |
| no dip | `pwd=0`, or `e1` other than `0xc2fa` | the controller dropped the dip writes; the shot did not run |

CRC_STATUS (`0x820070`) is four 2-bit fields, one per fuse block, `01` = pass. A poisoned shot read by the stock
classifier shows DSOV 0, CRC 0 and mask 0 because nothing was read: count a real flip only with a nonzero mask. On
card B about 600 frames showed DSOV 0 with the mask stuck at `0xFFFFFEFE`, and a sense on one of them poisoned the
controller. Wait for the full mask. Every frame in detail:
[finding the sweet spot](https://cmp.wiki/wiki/Voltage-glitch_unlock:_finding_the_sweet_spot).

### 2.5 Poison, latches and lost links: what each costs

- **Poison is sticky.** Neither the next PEX_RST nor a park clears it, and every later shot of that boot reads
  poisoned. It ends the boot for a power cycle, unless the runner runs with `POISON_RESET=1` (hunter:
  `--poison-reset`): it waits until GFW reads ready (upstream's rule 2 forbids a PEX_RST while GFW is `0x01`), sends
  one 100 ms PEX_RST pulse at the stock rail and requires a healthy locked read. On card C that cleared 64 of 64
  poisons in one 129-shot boot, about 6 s each instead of a power cycle. A glitch shot's own 1 ms reset does not.
- **The controller latch** (STATUS_WORD `0x2042`) clears only with a power cycle. On card E the standard 3 x 198 µs
  train latched it at 381 mV with restore 750 mV; restore 588 mV or pulses of 80 to 120 µs did not (one first shot at
  331 mV with delay 200 µs still latched). Start every new card shallow and step down.
- **A lost link on a stock card:** the runner sends one 100 ms PEX_RST pulse and wants a healthy read, or ends the
  boot. A crashed GPU under its own PWM-VID control asks for the ~0.3 V floor and every reset then browns out: the
  park holds the rail at stock (787.5 mV) under PMBus, checks READ_VOUT, pulses PEX_RST, waits, reads config space
  and only then hands the rail back ([`tools/vfi_park.py`](../tools/vfi_park.py),
  [`tools/vfi_rescue.py`](../tools/vfi_rescue.py)).
- **A lost link on an already-burned card latches.** On card B the controller was fine (READ_VOUT 752 mV) and the root
  port showed DLActive-, and no PEX_RST pulse, 299 more dips or PCI remove and rescan brought it back. Only a cold
  power cycle did. A rail at about 37 mV after the hand-back is a dead GPU sending no VID, not a regulator trip.
- **Link loss depth depends on the recovery.** On card E a gentler recovery (stock slew, or restore 625 mV) kept the
  link one code deeper; on another card a higher restore (800 to 825 mV) did. Try both directions at a card's edge.
- **Shooting through stalls** (`SHOOT_THROUGH_STALLS=1`, `--shoot-through`) breaks upstream's rule 2 and can wedge the
  GFW boot sequencer; a clean power cycle recovered the card every time on the lab's bench. Card G hit with it on. It
  is off unless the card's owner agrees.

### 2.6 Temperature

Use temperature as a gate, not as a search axis. The lab's hits came at about 35 to 41 C read from the controller's
own sensor (READ_TEMP1 taken as 0.1 C per bit; the scale is not confirmed, so watch the trend). Within a recipe it
made no measurable difference to losses, but edges do move: cooling moved card C's edge up one code, 43.7 C moved it
down, and at 47 to 49 C every shot was lost. `cimp`'s default band is 39.5 to 40.6 C, close to card E's overlap
runs; set one your room and fan can hold, or every boot waits and ends with exit 16. `cimp watch` tells you when to
turn the fan up or down.

### 2.7 The search, in order

From [`SWEET_SPOT.md`](SWEET_SPOT.md), which has both worked examples and the commands:

1. **Baseline** (section 1.7) and the plan (section 1.8).
2. **The community train**, shallow to deep: 3 x 198 µs, gap 150 µs, `t_dip` -60 µs, delay 117 µs (s1 -177 µs, the
   first pulse spans the release), restore 750 mV, fast 1, no parks. `cimp hunt train`. Cap it at 100 to 200 shots:
   it gave one hit on a stock card in 5,335 train shots in the lab's logs. On a DSOV-0 stall, dwell.
3. **A map that is not monotonic** (a deeper code reads under between poison and lost): map the fuse read with one
   fast dip, s1 +40 to +160 µs in 5 µs steps at the poison-edge code. `cimp hunt readmap`.
4. **The init phase:** one fast dip whose write ends at the release (s1 -47 µs) and earlier, to about -100 µs,
   shallow to deep. Look for sentinel-0 stalls, then the poison edge, 1 to 3 µs wide. `cimp hunt init`.
5. **The slow slew:** at the code where s1 near -47 µs is under and a few µs earlier is poison, switch to fast 0 and
   step s1 from -47 to -100 µs; the rail is still falling at the release, between two codes. `cimp hunt slow`.
6. **The overlap edge (push3):** if the card goes from under straight to link loss, CRC44 or over on every shape
   above, scan one long dip whose restore write is in flight across the release, so the rail comes back up 0 to 17 µs
   after it ([`OVERLAP_EDGE.md`](OVERLAP_EDGE.md)). `cimp hunt overlap`.
7. **Hold** any goldilocks frame. `cimp hunt tally` names the next phase after each one.

What the lab's logs and maps say:

- **Never score the first shot of a boot.** It starts from the idle rail (about 690 mV against 745 to 760 mV) and
  lands 26 to 40 mV shallower; none of the lab's 12 goldilocks frames was a first shot.
- **Aim by the real trough, not the command.** The regulator undershoots the command by 39 to 60 mV, steady within a
  card (card C about 58 to 61 mV, card E about 40 to 47 mV). With the NVVDD lead and the debug build (`--trace`), two
  shallow shots measure it. Card C's burnable frame came at the same 334 mV trough as card E's.
- **A passive goldilocks whose sense poisons was too deep.** Go one step shallower or slow the slew.
- **A sentinel-0 frame came one step before the hit** on all five cards with a logged lead-up (read back from runs
  that hit, so a tendency): keep going one step deeper (`--continue-sent0`).
- **Edges are 1 µs sharp:** 5 µs steps to map, 1 to 2 µs near an edge, 3 or 4 counted shots per cell, and repeat any
  single odd read before believing it.
- **Delay is a timing knob too.** Only `t_dip - delay` reaches the firmware. On push2 no PMBus write (about 47 µs
  each, queued) may be in flight across the release, so some delays cannot be played with a given train; the hunter
  checks every step and leaves those out. Pulse widths below 36 µs are sent as 36 µs.
- **The NVVDD lead, a disagreement.** The method page says take it off for glitch runs (one card crashed 30 to 70 mV
  earlier with it attached) and that the ADC trace means nothing without it. The lab's later hits on cards C and E
  and the GEN23 shots report the trough, so they were shot with the lead on. Measure the offset with it; if a card
  behaves differently with it, take it off.

The record of the push2 nights on card E, with the delay rule and the CRC compass: [`METHOD.md`](METHOD.md); what the
bench measured: [`MEASUREMENTS.md`](MEASUREMENTS.md).

### 2.8 What hit on the lab's cards

| Card | The shot that hit | Real trough | Temperature | Shots |
|---|---|---|---|---|
| A, first window | 300 mV commanded, 3 x 198 µs, restore 750 mV, default timing, an adaptive run | | about 40 C | 11 |
| A, second window | 331 mV, 3 x 198 µs, `t_dip` 0, the first shot after a park | | about 39 C | about 1,200 over three boots |
| B | 356 mV, 3 x 198 µs, default timing | | about 36 C | the first cell at that depth |
| C | 394 mV, one 130 µs dip, fast 0, restore 625 mV, dip write -177 µs, restore write -47 to 0 µs | 334 mV | 38.6 C | third shot of a shallow-side scan, after about 4,000 shots and two passive frames at 388 mV whose sense poisoned |
| E | 381 mV, one 137 µs dip, fast 1, restore 625 mV, restore write -40 to +7 µs across the release (push3) | 334 mV | 39.7 C | 13th shot of the first push3 run, after more than 3,000 shots |
| F | an adaptive run | | about 38 C | the first adaptive block, within seconds |
| G | 369 mV, the community train, no parks, shooting through stalls, 10 warm-up shots per boot | | | about 100 at that setting; the hit came right after a DSOV-0 stall |
| H | 375 mV, one 198 µs dip, fast 0, restore 750 mV, s1 -55 µs (dip write -55 to -8 µs) | | | the first counted shot of a fresh boot, after mapping the fuse read |

Commanded depths at the hit ranged from 300 to 394 mV, so do not copy a number: copy the method, and compare by the
trough.

### 2.9 How many shots

- **The lab:** from 11 shots (card A) and seconds (card F) to more than 3,000 (card E) and about 4,000 (card C).
- **Members:** from under a minute and "under 100 tries" to 3,000 to 4,000 per card; one tuned card gives "a 99%
  chance of goldilocks within 25 shots" once its settings are known (@dalzyyy).
- **An already-burned card:** two or three shots each with the recipe below.

### 2.10 An already-burned card that needs one more record

A burned card behaves like a different card: choose the recipe by its state, not by what opened it the first time.
On burned card B the community train that had opened it gave more than 500 shots of under or a lost link and not one
DSOV-0 frame. What worked on all five of the lab's GEN23 sessions (cards H, B, A, F, G) was one dip with fast 0,
s1 -55 µs (the dip write ends about 8 µs before the release), 198 µs, restore 750 mV, at real troughs of 309 to
322 mV, in two or three shots per card:

```sh
./cimp hunt slow --v 381,375,368,362,356 --s1-from -55 --s1-to -55 --reps 3 \
      --continue-sent0 --poison-reset --out g23.json
```

End the boot at the first lost link on a burned card: only a cold power cycle brings it back. Members also report
that each burned row makes the next glitch harder, which is one more reason to burn everything in the first window.

## 3. At the goldilocks

When the runner holds a goldilocks it stops; `cimp watch` rings, and an agent hands over. **Leave the card as it is:**
no park, no power cycle, no more reads unless you mean them. A power cycle throws the frame away. A held frame is not
an unlock: nothing is permanent until a record is burned, and only a cold boot verifies one.

The burn itself is yours, with your own reviewed tool and plan. What the lab's burn flow did, as described on the
[method page](https://cmp.wiki/wiki/Voltage-glitch_unlock:_lab_method_on_a_Pico_2_W) (no command here):

1. **Check the window before arming:** fuse rows 0 to 487 identical to the cold read, every target row blank. The IFF
   rows 488 to 507 read differently in the goldilocks state; that is expected. Members also check that row 0 reads its
   known value: on one stuck card the arming writes held while the array read all ones.
2. **Set EN_SW_OVERRIDE** (`0x820040`) to 1 and read it back. On card G the arm step (SBFE shadow `0x821108` to 0,
   WDATA_WR_SECURE `0x82048C` to 0) only stuck after it.
3. **Sense first.** A goldilocks often shows EFP_STATUS (`0x820078`) 0: the shadows were not sensed. After CMD_SENSE,
   EFP goes to 1, DSOV stays 0, CRC stays `0x55` and PLM_f8 (`0x8200F8`) stays `0xFFFFFFFF`. If the sense poisons the
   controller (card C at 388 mV: PLM_f8 `0xFFFFFFFE`, FUSECTRL `0xBADF510E`), nothing was written: the dip was too
   deep (section 2.7).
4. **Burn the test row** (the first record of the plan) and read it back.
5. **Burn the rest one row at a time**, reading back each row, in the plan's order: compute (GPC last), memory (FBP
   last), PCIe with the GEN23 record. Stop at the first mismatch or controller fault.
6. **After the last row** FUSECTRL must be idle and CRC `0x55`.
7. **Park, power the host fully off, cold boot.** Never reboot straight from an open window.

States that look close and are not burnable: DSOV 0 with mask `0xFFFFFEFE` (card B: the sense poisoned), CRC44
(card E: the sense kept CRC at `0x44`), and a passive goldilocks whose sense poisons (card C). See
[`SWEET_SPOT.md`](SWEET_SPOT.md#after-a-hold) and the method page's "States that look close but cannot be burned".

## 4. After the glitch

### 4.1 Cold-boot verification

`CMD_SENSE` re-reads the fuses into the shadows but does not re-apply the FF chain to the option registers: on card B
the GPC, FBP and `PCIE_MAGIC_BITS_D` registers kept their old values for the rest of the session. A read-back in the
same session proves that a row was written, not that the record does what you planned. Power off fully, cold boot
into the glitch entry, and read again with `tools/vfi_snap.py --rows`:

| Read | Expect |
|---|---|
| GFW boot progress (`0x118234`), FUSECTRL (`0x820000`), CRC_STATUS (`0x820070`) | `0xFF`, idle `0xE0040000`, `0x55` |
| DSOV (`0x820084`) | 1: normal for every cold card, burned or not |
| The 512 fuse rows | two passes that match |
| Your planner on the new read | every record parsed, nothing left to burn (a no-op) |
| GPC_DISABLE (`0x820350`), PES, TPC disables | only the defective units: `0x00` on cards with no defective GPC, `0x80` on card F, `0x20` on card E |
| `SM now` | your plan's count (cards A and G: 122) |
| FBP_DISABLE (`0x820364`) | the two defective FBPs only: `0x840` on most cards (`0x852` before), `0x09` on card E, `0x24` on card H |
| FBIO and ROP_L2 disables (the FBPA mask decodes from the FF rows) | `0xC03000` with FBP `0x840`; `0xC30` on card H. FBP n owns bits 2n and 2n+1 |
| `PCIE_MAGIC_BITS_D` (`0x820520`) | `0x14680000` |
| `OPT_PCIE_BOOT_GEN3_DIS` (`0x820580`), `OPT_DISABLE_GEN3_SPEED` (`0x820250`) | 0, 0 |
| `OPT_PCIE_BOOT_GEN23_DIS` (`0x82057C`) | 0. `vfi_snap.py` does not read it; `tools/pcie/cmp-gen23read <bdf>` does, and the cold `LnkCap` shows it (16 GT/s cleared, 2.5 GT/s still fused) |
| `lspci -vv` on the cold card | `LnkCap` 16 GT/s x16, `LnkCap2` 2.5 to 16 GT/s; XVE LnkCap (`0x88084`) `0x00456104` |

Keep the new read private like the first one.

### 4.2 Under a driver: SMs and 80 GB

After verification, boot your normal entry with the driver. The base is cmpunlocker
([Driver unlock](https://cmp.wiki/wiki/Driver_unlock)) on nvidia-open 615.71.09, the most widely confirmed version;
its RECONFIG override supplies the last 4 SMs (122 to 126 on cards A and G), so keep it loaded.

- **Before the driver binds, DSOV must read 1.** A card still at DSOV 0 has not been power cycled since a glitch. A
  variant driver with probe-time fuse overrides writes to such a card; the lab's own Gen3 build for the 10 GB card
  does that to an 8 GB card. Never load a driver during a campaign.
- **80 GB needs a driver change.** Mainstream cmpunlocker programs the 64 GiB geometry on every 8 GB card, burned or
  not, so a card burned for 80 GB still shows 65536 MiB.
  [`driver/fb-geometry-80g.patch`](../driver/fb-geometry-80g.patch) ([`driver/README.md`](../driver/README.md)) is
  a patch for the cmpunlocker driver on open-gpu-kernel-modules 615.71.09. It gives 80 GiB (LMR `0x28B`) only to a
  card that itself reports exactly 10 of 12 FB partitions active with consistent FBP, FBPA, FBIO and ROP_L2 masks,
  and keeps 64 GiB otherwise. `CmpFbGeometry=0` in `NVreg_RegistryDwords` turns it off, and `=2` only logs what it
  would do. It runs on the lab's seven 80 GB cards at 81920 MiB each.
- **Never hard-code the geometry.** The driver log on the lab's server shows three different FBP off masks among the
  seven 80 GB cards: `0x840` (five cards), `0x024` (card H) and `0x009` (card E). One public 80 GB patch hard-codes
  the first (FBP_DISABLE shadow `0x840`, CTRL_FBPA `0x0C0C`, CTRL_FBP `0x12`); on cards E and H it would switch on
  defective FBPs.
- **Keep every registry key in one `NVreg_RegistryDwords` string.** A second `options nvidia
  NVreg_RegistryDwords=` line replaces the first and silently drops its keys.
- **Check that the unlock took** ([Verifying an unlock](https://cmp.wiki/wiki/Verifying_an_unlock)): the patched
  module is the one loaded, `nvidia-smi --query-gpu=index,memory.total --format=csv` shows 81920 MiB, and a CUDA
  kernel that records the SM ID of every block counts the distinct SMs you planned.

### 4.3 Memory test and ECC

- **`memory.total` is not proof.** Write unique data to every byte and read it all back. memtest_vulkan (the
  standard 5-minute test, then the extended one), cuda_memtest (its structured patterns; test 6 caught one card's
  fault) and a near-full CUDA write and verify are the usual tools
  ([Memory errors and ECC](https://cmp.wiki/wiki/Memory_errors_and_ECC)).
- **Run the memory test right after a cold boot**: one bad card failed only then.
- **The top of VRAM:** builds without cmpunlocker's late-PMA fix (PR #32) give Xid 31 and cuda_memtest errors in the
  last few hundred MB. That is the reserved tail, not bad HBM.
- **ECC:** cmpunlocker v0.5 can report ECC as enabled, but "ECC Enabled, 0 errors" proves nothing; nobody has shown a
  corrected error, and one member found that ECC written through IFF records is reset during startup. Treat the HBM as
  non-ECC.
- **HBM temperature:** one owner saw errors above about 75 C HBM, and HBM reads about 15 C above the core. Watch
  `temperature.memory`.

### 4.4 PCIe: Gen2, Gen3, Gen4

What each step needs on a burned card:

| Link | Needs | Measured on the lab's EPYC server (pinned host copies, per card) |
|---|---|---|
| Gen1 | stock | |
| Gen2 | cmpunlocker | about 6.5 GB/s at x16 |
| Gen3 | both Gen3 disables cleared, and the walk through the driver at every boot | about 13 GB/s at x16 |
| Gen4 | all four fields cleared (`PCIE_MAGIC_BITS_D` bit 25 and GEN23 too), the Gen3 walk, the E1 PHY init and one retrain at every boot | 22.4 to 25.1 GB/s at x16 |

The driver stops at Gen3 by itself even with every fuse cleared (`nvidia-smi` reports gen max 3); Gen4 is a runtime
step after it. [`tools/pcie/`](../tools/pcie/README.md) is the kit the lab's EPYC server runs at every boot:

- **Gen3 needs no driver patch beyond the unlocker** on a burned card: a per-device
  `NVreg_RegistryDwordsPerDevice="pci=<bdf>;RMPcieLinkSpeed=0x5"` plus `RmForceEnableGen2=1`, and the RM speed helper
  `cmp-pcie-speed`, built from `tools/set_pcie_speed.c` of the lab's 10 GB PCIe repository,
  cmp170hx-10gb-pcie-gen4 (build line in the kit's README). The walk: RM speed 1, check Gen1; RM speed 2, check
  Gen2; target link speed 3 on the root port and the card; RM speed 3; 60 s to settle. (The wiki's runs on cards B
  and H loaded `RMPcieLinkSpeed=0x15` in a global string; the kit sets `0x5` per device.)
- **Gen4** runs only on a card whose `OPT_PCIE_BOOT_GEN23_DIS` reads 0, from a trained Gen3 link with the driver
  bound: the seven E1 PHY writes that CMPGlitch worked out (the table is on
  [PCIe Gen4 on the 10 GB card](https://cmp.wiki/wiki/PCIe_Gen4_on_the_10_GB_card); write 7 is `LINK_CONFIG_0`
  bits 19:18 to 0), then one retrain to 16 GT/s from the root port.
- **Why the lab's EPYC server used to halt.** With the first writer, E1 write 7 halted the whole host in 5 of 15 runs
  (a sync flood; the BMC had to power cycle it), never on the Intel bench. The cause was the write method: Python's
  `struct.pack_into` zeroes its destination before it packs, so each E1 write stored `0x00000000` for a moment
  (`LINK_CONFIG_0` 0), which knocked the link out, and the AMD platform answered with a sync flood. The fixed writer
  (v3) makes one aligned 32-bit store per register (a `memoryview` cast), sets Hardware Autonomous Speed Disable
  (LnkCtl2 bit 5) on the card and the root port before write 7, then keeps a 3 s quiet window with no BAR0 access and
  checks the root port first. With v3: 12 of 12 clean E1 runs on that server, and no halt at any boot of the service
  since. Patch `0012` makes the same fix in the
  glitch tools' `Bar0.wr32`. This supersedes the wiki's
  [PCIe Gen4 on a burned 8 GB card](https://cmp.wiki/wiki/PCIe_Gen4_on_a_burned_8_GB_card) page, which still calls
  the halts open.
- **At every boot:** stage 1 walks each `0x20C2` card to Gen3 through the driver; stage 2, on the cards whose GEN23
  reads 0, does the seven E1 writes and one retrain to Gen4. A marker file per card is written before each step and
  removed after it; a marker left over at boot means the host went down during that card's step, and that card is
  skipped from then on. Five of the seven burned cards reach Gen4 x16 at every boot, with 0 Xid and 0 AER; the
  other two sit in slots where the guard disabled the Gen4 step during testing, and run at Gen3. Start the cards'
  users after the service: the walk refuses a card with a compute process on it.

Traps:

- **Gen4 is volatile.** Every boot redoes the walk, the E1 writes and the retrain.
- **Never run the E1 on a card whose GEN23 still reads 1.** Such a card advertises only 2.5 GT/s after a cold boot,
  and on the lab's EPYC server E1 write 7 halted the host.
- **Never unbind and rebind the driver at Gen4.** The probe returned -5, BAR0 read `0xbadf1020` and the driver logged
  Xid 140. Reboot for each attempt instead.
- **One retrain per boot, never a loop.** A failed 16 GT/s transition is more likely than a Gen3 one to take a card
  off the bus.
- **`nvidia-smi` keeps showing Gen3** at 16 GT/s: RM cached the link at boot. Judge by `LnkSta` at both ends and a
  pinned copy test, and check the width did not drop.

### 4.5 Burn-in

Test one card at a time, with a stop rule and a watcher, before you trust it with work
([Testing and burn-in](https://cmp.wiki/wiki/Testing_and_burn-in)):

1. **Identity:** `lspci`, `nvidia-smi`, 0 Xid since boot, the memory size you expect.
2. **Memory, quick:** memtest_vulkan, the 5-minute test, right after a cold boot.
3. **Compute burn:** gpu-burn with tensor cores (`gpu_burn -tc`), `errors: 0` on every line.
4. **Memory, full:** a write, read and verify over nearly all of the memory, the upper range included.
5. **Tensor-core correctness:** the same matmuls on every card, compared bit for bit. Cards have passed memory tests
   and returned garbage from the tensor cores.
6. **Throughput:** BF16 tensor at about 150 to 200 TFLOPS (mmapeak or a GEMM test).
7. **A real workload** that fills the upper VRAM, then a warm rerun of 3 to 6 and the kernel log: still 0 Xid.
8. **The link at Gen4:** `LnkSta` 16 GT/s at both ends with the width kept, copies well above the Gen3 figure, no new
   Xid or uncorrectable AER and a correctable AER count that does not climb, over a 30-minute soak with gpu-burn and
   continuous copies, then a re-check after idle (RM may retrain to its cached Gen3 without a log line).

Members' stop rules: 80 C core or 85 C memory, any Xid, a GPU that disappears, or a verification mismatch. A power
cap (for example `nvidia-smi -pl 180`) during tests is common practice.

### 4.6 Running it

- **Mining** is bound by compute and power, not the link. Card G ran a mining load at 100 percent under the driver.
  Card C with pearlhash: 1.079 TH/s per W at 200 W, 241.6 TH/s at 225 W, no gain above 275 W, and GPC clock offsets
  gave nothing.
- **Inference:** on the lab's EPYC server Gen4 made a large model's cold prefill 15 percent faster and decode 0.3 to
  1 percent faster; decode is not link bound. Pipeline parallel runs on narrow links; tensor parallel and P2P need
  width ([Risers and bifurcation](https://cmp.wiki/wiki/Risers_and_bifurcation)).
- **P2P between cards** measured 13.15 GB/s on every pair at Gen3 and 20.2 to 26.2 GB/s at Gen4. P2P needs a driver
  build that supports it ([Cmpunlocker forks](https://cmp.wiki/wiki/Cmpunlocker_forks)).
- **Changing a burned card later** costs rows: a wrong record is fixed with more records (or an all-ones row
  invalidation, which also spends the row). Keep the reserve.

## 5. Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| `I2C ERR -2`, or `I2C ERR bus low`, in preflight | a lead off its via or on the wrong pin, a short, or no ground | power off; reseat SDA (GP0), SCL (GP1) and ground. The lab's cards answer at `23 24 25 26 40` on the Pico's `@s` scan |
| The Pico shows no serial device after flashing | a UF2 built with the wrong SDK | build as in section 1.6 |
| `picotool load -f` does not reach the bootloader | a running push2 or push3 board does not re-enumerate | hold BOOTSEL, unplug and replug, then `picotool load -v -x` |
| "direct PCI access is restricted", every BAR0 or `setpci` write refused | Secure Boot on, kernel lockdown | turn Secure Boot off; check the BIOS after every update |
| Preflight: `nvidia` loaded or a driver bound | the wrong boot entry, or a desktop service holding the GPU | the glitch entry: `pci-stub`, blacklist, updated initramfs, no desktop |
| Preflight: a VRM profile register holds its fast value | an interrupted shot | power the card fully off |
| `IDENTITY MISMATCH` or `DIE ID MISMATCH` | another card is in the slot, or the card's settings are wrong | stop; never edit the plan to fit |
| Link Gen1 x8 (or x4) on the bench riser | normal: the glitch needs no width or speed | nothing; speed is a driver step after the burn |
| The card never enumerates; MP2888B silent at `0x25`; NVVDD near 0 V | no core rail (card D) | a board repair; try another slot and riser first |
| STATUS_WORD `0x2042`, READ_VOUT about 41 mV | the controller latched its output off | power cycle; restore 588 mV or shorter pulses; step down from shallow |
| FUSECTRL or DSOV `0xBADFxxxx` | poison: the dip corrupted the fuse read | read nothing else; power cycle, or `POISON_RESET=1` once GFW reads ready |
| FUSECTRL `0xBAD0xxxx` | the fuse unit did not answer | repeat the setting before believing it |
| Config space reads `0xffffffff` after a shot | the GPU crashed | stock card: one 100 ms PEX_RST pulse or a park; burned card: a cold power cycle |
| The host freezes on a config read after a crash | a half-booted card answering CRS (Intel root complex) | park before any config read: the tools do; add no reads of your own |
| Rail about 37 mV after the hand-back, no fault bits, on a burned card | a dead GPU sending no VID; the link latched | cold power cycle; end the boot at the first lost link |
| Every shot under, then lost, with nothing in between | the card browns out before its fuse read moves | match the trough, the slow ramp, then the push3 overlap edge (section 2.7) |
| DSOV 0 with mask `0xFFFFFEFE`, or CRC `0x44`, or `0x00` | over or skipped blocks: not burnable | never sense it; change depth or the rise time |
| A passive goldilocks whose sense poisons (PLM_f8 `0xFFFFFFFE`) | the dip was too deep | one step shallower, or fast 0 |
| A burned card will not glitch with the recipe that opened it | a burned card is a different card | the single slow dip of section 2.10 |
| `TEMP GATE FAILED`, exit 16 | the card never reached the band | follow the fan cue, or move the band |
| Still 64 GB (65536 MiB) after burning the memory set | mainstream cmpunlocker programs 64 GiB on every 8 GB card | the 80 GB geometry patch (section 4.2); first check that FBP_DISABLE shows only the two defective FBPs |
| 64 GB whatever you plan | four FBPs marked defective | a 64 GB card; burn compute and PCIe only |
| Fewer SMs than planned under the driver | cmpunlocker's RECONFIG override is missing (the last 4 SMs), or the compute records do not do what the plan said | keep cmpunlocker loaded; read the GPC and TPC disables after a cold boot |
| DSOV reads 0 just before the driver binds | the card has not been power cycled since a glitch | do not load the driver; power the host fully off |
| Cold `LnkCap` stays 2.5 GT/s on a burned card | `OPT_PCIE_BOOT_GEN23_DIS` still fused | Gen3 through the driver walk only; never the E1. Clearing it needs one more glitch session |
| The host halts (sync flood) at E1 write 7 | a writer that stores zero first (`struct.pack_into`), or GEN23 still 1 | the v3 writer in `tools/pcie/`; never the E1 on a GEN23 1 card |
| The Gen4 retrain fails in one slot | that slot or riser (two different cards failed Gen4 in the same slot on the lab's server) | leave that card at Gen3 (the kit's guard does after a halt); another slot or a shorter path |
| x16 at Gen2, x8 at Gen4 | a marginal capacitor joint | redo the joints |
| Driver rebind at Gen4: probe -5, BAR0 `0xbadf1020`, Xid 140 | unbind and rebind at Gen4 | reboot instead |
| `nvidia-smi` says Gen3 on a 16 GT/s link | RM cached the link at boot | judge by `LnkSta` and a pinned copy test |
| cuda_memtest errors in the last few hundred MB | a driver build without the late-PMA fix | a build with it, or cap the test |

## 6. Where to read more

In this repository:

- [`README.md`](../README.md): the front page, CiMP both ways, setup, safety behaviour, status.
- [`AGENTS.md`](../AGENTS.md): the rules for an agent that runs the bench, the loop, exit codes, holds.
- [`SWEET_SPOT.md`](SWEET_SPOT.md): the search order with cards G, H and C as worked examples.
- [`OVERLAP_EDGE.md`](OVERLAP_EDGE.md) and [`PUSH3.md`](PUSH3.md): the push3 overlap shot that finished card E, and
  how to flash push3.
- [`CIMP.md`](CIMP.md): every `cimp` command, setting and the watch panel.
- [`RUNNER.md`](RUNNER.md): the per-boot runner and the launchers by hand.
- [`AUTONOMOUS_AGENT.md`](AUTONOMOUS_AGENT.md): what an agent controls and what stays with people.
- [`METHOD.md`](METHOD.md) and [`MEASUREMENTS.md`](MEASUREMENTS.md): the push2 nights and what the bench measured.
- [`firmware/README.md`](../firmware/README.md): the twelve patches.
- [`tools/planner/README.md`](../tools/planner/README.md): the shot ledger and the next-shot planner.
- [`tools/pcie/README.md`](../tools/pcie/README.md): Gen3 and Gen4 at every boot.
- [`driver/README.md`](../driver/README.md): the 80 GB geometry patch.

On cmp.wiki:

- [Voltage-glitch unlock (GA100VFI)](https://cmp.wiki/wiki/Voltage-glitch_unlock_(GA100VFI)): the community page:
  reported outcomes, glitcher builds, members' tips, the short safety rules and the brick reports.
- [Voltage-glitch unlock: lab method on a Pico 2 W](https://cmp.wiki/wiki/Voltage-glitch_unlock:_lab_method_on_a_Pico_2_W):
  parts, wiring photos, the tool fixes, the burn flow, the settings that hit.
- [Voltage-glitch unlock: finding the sweet spot](https://cmp.wiki/wiki/Voltage-glitch_unlock:_finding_the_sweet_spot):
  the search step by step, every frame, the GEN23 session, the shot budget.
- [Voltage-glitch unlock: lab results and fuse findings](https://cmp.wiki/wiki/Voltage-glitch_unlock:_lab_results_and_fuse_findings):
  every card's numbers, the memory and PCIe records, the four link-speed fuses.
- [Floorsweep read of the 8 GB card](https://cmp.wiki/wiki/Floorsweep_read_of_the_8_GB_card:_gated_versus_defective_partitions):
  gated against defective partitions.
- [Fuses and floorsweep maps](https://cmp.wiki/wiki/Fuses_and_floorsweep_maps): reading your card's map, the fuse
  model, FF and IFF records.
- [8 GB compute and HBM: limits and open questions](https://cmp.wiki/wiki/8_GB_compute_and_HBM:_limits_and_open_questions):
  members' SM and memory counts, 64 GB cards, open questions.
- [Unlock without bricking](https://cmp.wiki/wiki/Unlock_without_bricking): what prevents damage, and what not to do.
- [cmp170hx-ffcalc](https://cmp.wiki/wiki/Cmp170hx-ffcalc): the burn tool the lab used, and its caveats.
- [RIR fuse burn](https://cmp.wiki/wiki/RIR_fuse_burn) and
  [cmp-170hx-rir-burn-util](https://cmp.wiki/wiki/Cmp-170hx-rir-burn-util): the 10 GB card's route, for contrast.
- [PCIe x16 capacitor mod](https://cmp.wiki/wiki/PCIe_x16_capacitor_mod): parts, soldering, verifying x16.
- [Risers and bifurcation](https://cmp.wiki/wiki/Risers_and_bifurcation): risers, adapters, switches, width.
- [Driver unlock](https://cmp.wiki/wiki/Driver_unlock): cmpunlocker, supported driver versions, install.
- [Cmpunlocker forks](https://cmp.wiki/wiki/Cmpunlocker_forks): forks, P2P builds, 80 GB patches, the
  `struct.pack_into` warning.
- [Verifying an unlock](https://cmp.wiki/wiki/Verifying_an_unlock): that the driver, memory, link and compute are real.
- [Gen2 link retrain](https://cmp.wiki/wiki/Gen2_link_retrain): how cmpunlocker reaches Gen2.
- [PCIe Gen3 on the 10 GB card](https://cmp.wiki/wiki/PCIe_Gen3_on_the_10_GB_card): the RM speed walk.
- [PCIe Gen4 on the 10 GB card](https://cmp.wiki/wiki/PCIe_Gen4_on_the_10_GB_card): the E1 table and the pass gates.
- [PCIe Gen4 on a burned 8 GB card](https://cmp.wiki/wiki/PCIe_Gen4_on_a_burned_8_GB_card): cards B and H at Gen4
  (its host-halt section predates the v3 writer; see section 4.4).
- [Memory errors and ECC](https://cmp.wiki/wiki/Memory_errors_and_ECC): memory tests, the late-PMA fix, ECC.
- [Testing and burn-in](https://cmp.wiki/wiki/Testing_and_burn-in): the test sequence and stop rules.
- [Driver and unlock failures](https://cmp.wiki/wiki/Driver_and_unlock_failures): when the driver or unlock fails.

Credits: Kate Land ([kate-land/ga100vfi](https://github.com/kate-land/ga100vfi)) for the method;
[dalzyu/pico-ga100vfi](https://github.com/dalzyu/pico-ga100vfi) for the glitch tool this repository drives;
sayhellotojungle for cmp170hx-ffcalc; CMPGlitch for the E1 PHY init; @matstatman for gpcprobe; and the members whose
reports are credited on cmp.wiki.
