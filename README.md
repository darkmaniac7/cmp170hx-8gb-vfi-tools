# CMP 170HX 8 GB: voltage-glitch bench tools

Bench tools and firmware fixes for the Pico voltage-glitch ("goldilocks") method on NVIDIA CMP 170HX 8 GB cards
(`10de:20c2`), built on [dalzyu/pico-ga100vfi](https://github.com/dalzyu/pico-ga100vfi).

**How it is meant to be used:** an LLM coding agent with a shell on your controller machine runs the whole thing.
It plans each phase, power-cycles the bench, shoots, reads the logs, picks the next phase and stops when a goldilocks
is held, through one command, `cimp`. You do the physical work (cards, harness, probe, fan) and every burn decision.
Every step also works by hand. Both ways are laid out under [CiMP](#cimp-the-whole-bench-behind-one-command).

**New here? Start with [`docs/GUIDE.md`](docs/GUIDE.md):** the whole route in order, from choosing and preparing a
card, through the glitch and the hand-off to the burn, to what comes after it: checking the card, 80 GB under the
driver ([`driver/`](driver/README.md)) and PCIe Gen3 and Gen4 at every boot ([`tools/pcie/`](tools/pcie/README.md)).

For Petri Krohn's community reference covering the full CMP 170HX to A100 conversion (10 GB RIR and 8 GB voltage-glitch gates, BAR0 fuse-write mechanics, ordered FF and column burns, A100 VBIOS cross-flash, ECC, MIG, vGPU, SR-IOV and brick recovery), see [`docs/ALLSPARK.md`](docs/ALLSPARK.md).

For the fuses themselves, [`docs/FUSES.md`](docs/FUSES.md) lists every field: its register, its place in the fuse
chains, how to compute its value from your own read, and how sure each entry is. [`tools/fuseplan/`](tools/fuseplan/README.md)
is an offline page that does that computation from a `vfi_snap.py --rows` read in your browser. It computes only: it
writes nothing to a card and gives no burn commands.

With this glitch setup, and a separate burn step that is not part of this repository, the lab finished seven
8 GB cards in November 2026. Compute went from 70 SMs to 122, 122, 120, 118 and 108 on the first five (126, 126, 124,
122 and 112 with the RECONFIG override), and on 2026-11-21 to 106 on card E (ceiling 110) and 120 on card C (ceiling
124). All seven have the 80 GB memory layout and PCIe fuses that advertise 2.5 to 16 GT/s, read back after a cold
boot; cards E and C were then checked under a driver (81920 MiB, 110 and 124 SMs with the override). On 2026-11-21
every one of them also got one more record, PCIE_BOOT_GEN23_DISABLE, so they now come up advertising 16 GT/s at a cold
boot; on cards that were already burned, the shot that hit was a single slow dip, two or three shots per card (see
[CiMP](#cimp-the-whole-bench-behind-one-command)). All seven now run in the lab's EPYC server at 81920 MiB each, with
the driver patch in [`driver/`](driver/README.md), and six of them at PCIe Gen4 x16 from every boot with
[`tools/pcie/`](tools/pcie/README.md). The cards fell to four routes:

- **Card G:** the community pulse train.
- **Card H:** where that train did not work, by mapping where the glitch lands in the GPU's boot and then slowing the
  rail's fall ([`docs/SWEET_SPOT.md`](docs/SWEET_SPOT.md)).
- **Card E:** it went from under straight to link loss or a skipped fuse check on every shape push2 can make. It
  needed firmware that lets a PMBus write run across the reset release (push3, [`docs/PUSH3.md`](docs/PUSH3.md)), so
  the rail can still be low at the release and come back up a few µs after it
  ([`docs/OVERLAP_EDGE.md`](docs/OVERLAP_EDGE.md)).
- **Card C:** one VID step shallower with a slow ramp, so its real NVVDD trough matched card E's winning 334 mV. Its
  regulator undershoots the command by about 60 mV, so the shots that looked right on the command were too deep.
  Mapping its poison edge took hundreds of shots; a 100 ms reset that clears a poisoned fuse controller in-boot
  (`POISON_RESET`, [`docs/RUNNER.md`](docs/RUNNER.md)) made each poison cost seconds instead of a power cycle.

[`tools/hunter/goldilocks_hunt.py`](tools/hunter/goldilocks_hunt.py) plans, runs and reads back the strategy for a
person or an LLM agent, and [CiMP](#cimp-the-whole-bench-behind-one-command) puts the configuration, a live status panel
and the hunter behind one command. One-step dither (`revert` 2) is in the firmware too, but it did not finish a card: see
[What moves the window](#what-moves-the-window). The method, wiring, parts and results are on cmp.wiki:

- [Voltage-glitch unlock: lab method on a Pico 2 W](https://cmp.wiki/wiki/Voltage-glitch_unlock:_lab_method_on_a_Pico_2_W)
- [Voltage-glitch unlock: lab results and fuse findings](https://cmp.wiki/wiki/Voltage-glitch_unlock:_lab_results_and_fuse_findings)
- [Voltage-glitch unlock (GA100VFI)](https://cmp.wiki/wiki/Voltage-glitch_unlock_(GA100VFI)), the community page

> **These tools only glitch and read.** None of them programs fuses. Burning FF records is permanent, a wrong
> record can brick a card, and no burn tool, burn planner or per-card plan is included here. A glitch by itself
> changes nothing permanent: a power cycle returns an unburned card to stock. You probe a powered card's board with
> needles and pull its reset line; a slipped probe can damage the card or the host. Use at your own risk.
> The after-the-burn parts write only volatile state: `tools/pcie/` writes PCIe registers of a finished card under the
> driver (redone at every boot; a wrong step can halt the host), and `driver/` changes how the driver sizes memory.

## CiMP: the whole bench behind one command

(Yes, the name is on purpose.)

CiMP (`./cimp`, or `python3 tools/cimp/cimp.py`) is the front door to everything in this repository. You describe
your bench once, and it drives the launcher, the runner and the hunter for you, shows you what the bench is doing in
plain words, and tells you when to touch the fan. It is standard library Python, and nothing in it senses, arms or
burns fuses: it glitches and reads, and it stops and hands over to you when a goldilocks is held.

| Command | What it is for |
|---|---|
| `./cimp config` | Set up a bench once, interactively: the bench host, ssh (key or password, jump host), power control (Wake-on-LAN, IPMI, or "press the button" with `POWER=manual`), the Pico port, the log directory, the temperature gate, and your cards. Profiles keep several benches apart (`--profile`). It writes `bench.conf` and the ssh settings for you. |
| `./cimp config --test` | Read-only checks of all of that (ping, ssh, the Pico port, the bench's Python, no `nvidia` module): exit 1 if anything is wrong. Run it before every session. |
| `./cimp hunt ...` | The goldilocks hunter with your profile's settings: plan a phase, dry-run it, then run it for real with `--execute`. It stops on any hold, poison, latch or outcome it does not know. |
| `./cimp watch` | A live panel in a second terminal: the phase in plain words (POWER CYCLE, BOOTING, PREFLIGHT, TEMP GATE, SHOOTING, HOLD with a bell), the temperature and which way it is going, a fan cue (fan UP, fan DOWN, leave it), and the last eight shots as words. `--log` gives one line per change. |
| `./cimp ladder`, `./cimp classify` | What each frame means; name every shot in a log. |

Every boot it runs goes through the same checks before a shot is fired: a fresh-boot guard (a short uptime and a boot
id that changed across the power cycle), the plan files' checksums
on both machines, a preflight (firmware marker, who owns the rail, the card's VRM profile, no driver), the card's
identity (GPC and SM masks) **and, since 2026-11-22, its die ID**: fuse rows 8 to 15 must match the dump your plan was
made from. Two of the lab's cards reported identical masks, and only the die ID told them apart. Then a two-sided
temperature gate, and the first shot of every boot is never scored.

### Before either way

```sh
git clone https://github.com/darkmaniac7/cmp170hx-8gb-vfi-tools && cd cmp170hx-8gb-vfi-tools
# 1. Firmware: apply firmware/*.patch to pico-ga100vfi, build and flash push3 (firmware/README.md, docs/PUSH3.md).
# 2. Bench host: a venv with the patched ga100vfi host package, and a glitch boot with no nvidia driver (Setup below).
# 3. This machine: ssh to the bench host with a key, and power control (Wake-on-LAN, IPMI, or you at the button).
./cimp config                         # answer the questions; add your card at the end
./cimp config --test                  # every check green before you go on
```

### With an agent (the way it is meant to run)

The repository has an [`AGENTS.md`](AGENTS.md) (with `CLAUDE.md` and `GEMINI.md` pointing to it), which most coding
agents read on their own when they open the repository. It holds the rules they never break, a first-session
walk-through that guides you from an empty bench to the first hunt, the loop, the exit codes, how to talk to the
person at the bench, what to do on a hold, and a troubleshooting table. Give the agent a shell on the machine with
this checkout (it reaches the bench over ssh, as configured), then paste something like this and fill in the card:

```text
You are running a voltage-glitch campaign on a CMP 170HX 8 GB card with the tools in this repository.
Read AGENTS.md and follow it, then README.md, docs/AUTONOMOUS_AGENT.md and docs/SWEET_SPOT.md, and run
`./cimp hunt strategy`.
Card: <label> (already set up in cimp). Goal: hold a goldilocks frame on it, then stop and tell me.
Loop: `./cimp config --test`; plan one phase with `./cimp hunt <phase> --out <file>`; dry-run it with
`./cimp hunt run <file> --card <label>` and show me the first dry run before you execute anything; run it with
`--execute`; follow it with `./cimp watch --log`; when it ends, `./cimp hunt tally <run dir>` and pick the next
phase from the strategy.
Stop and ask me on any hold, a poison or latch you cannot clear, an outcome you do not recognise, and anything
physical (cards, probes, harness, fan). Never sense, arm or burn fuses yourself.
Keep a journal of every run, and cite the run log for every claim.
```

From there it can run all night: many boots and thousands of shots, every one logged the same way. It will ask you
for the fan when `cimp watch` says so, and it hands over when a goldilocks is held. What stays with people, and the
guard rails, are in `docs/AUTONOMOUS_AGENT.md`. The burn step is not in this repository on purpose.

### By hand

Every step the agent does, you can type yourself:

```sh
./cimp hunt strategy                                 # the search order and the stop rules, worth reading once
./cimp hunt train --out plan.json                    # plan the first phase (the community pulse train)
./cimp hunt run plan.json --card <label>             # dry run: every boot and shot it would fire
./cimp hunt run plan.json --card <label> --execute   # power-cycle and shoot; stops on a hold
./cimp watch                                         # in a second terminal, the whole time
./cimp hunt tally hunt-logs/<run>                    # what happened, per cell, and which phase to plan next
```

A card is a few values from `tools/vfi_snap.py` on a cold boot: `./cimp config --set card.b.tag="card B"
--set card.b.gpc=0x00000023 --set "card.b.smc=SM now=70 ceiling=110"`. If you will burn from a plan, also give
`plan_local`, `plan_remote` and `plan_files`, and set `die_dump` to the 512-row dump among them (a dump with `ff_rows`,
or the file `vfi_snap.py --rows` writes): then a different card in the slot stops the run at preflight.

### Which phase first

- **A stock card (70 SMs):** start with the community train (`hunt train`) and cap it at one or two hundred shots;
  in the lab's logs it produced one stock hit in 5,335 train shots. Then follow `docs/SWEET_SPOT.md` (`readmap`,
  `init`, `slow`); for a card that goes from under straight to link loss, the push3 overlap edge (`hunt overlap`,
  `docs/OVERLAP_EDGE.md`).
- **An already-burned card that needs one more record** (the lab's GEN23 pass): the single slow dip. It hit four
  burned cards in two or three shots each, at a real NVVDD trough of 309 to 322 mV:

  ```sh
  ./cimp hunt slow --v 381,375,368,362,356 --s1-from -55 --s1-to -55 --reps 3 \
        --continue-sent0 --poison-reset --out g23.json
  ```

  `--continue-sent0` matters: on two cards a sentinel-0 frame came one step before the hit, and by default it ends
  the boot. Do not reuse the recipe from a card's first unlock: on one burned card the community train it had hit
  with before gave 500 shots of "under" or a lost link and never a single DSOV 0 frame.

### What the lab learned that applies to every card

- **Never score the first shot of a boot.** It starts from the idle rail and lands 26 to 40 mV shallower; none of
  the lab's 12 goldilocks frames was a first shot. The runner already skips it.
- **Aim by the real trough, not the command.** The regulator undershoots by 39 to 60 mV depending on the card (steady
  within a card). With an NVVDD probe and `--trace`, two shallow shots tell you the offset.
- **On a burned card a lost link needs a cold power cycle.** A reset, a rail dip or a PCI rescan does not bring it
  back. The launcher power-cycles for you; budget the time.
- **Temperature is a gate, not a knob.** Within a recipe it made no measurable difference to losses. Keep it in a
  band and let the depth do the work.
- **Identify cards by die ID.** See above.

`docs/CIMP.md` has every command, setting, profile, environment variable and the watch panel in detail;
`docs/AUTONOMOUS_AGENT.md` has the agent's side: what it controls, its loop, its stop rules and the guard rails
(`cimp config --yes`, `--json` and `watch --log` are made for it).

## What is here

| Path | What |
|---|---|
| `firmware/` | Twelve patches against pico-ga100vfi (`git am`-ready), with a README. The current firmware is push3 (`fw=lab-psr1-push3`, `0011`): push2 plus one change, a PMBus write may run across the reset release (`docs/PUSH3.md`). push2 (`0009`): `PEX_RST` released by a primed hardware alarm from SRAM, on time from the first shot of a boot, and a timeline that fails closed (card kept in reset on a failed step). Also: each card's own VRM profile restored after every shot, a classifier that stops at a poisoned fuse controller and no longer writes EN_SW_OVERRIDE unless asked, an unlock that always writes and reads back the config registers, lab knobs, per-step timing telemetry, a passive BAR0 snapshot, and serial replies read to the end of the line |
| `cimp`, `tools/cimp/cimp.py` | CiMP, one command for the bench: an interactive configurator with profiles, `--test` checks and generated `bench.conf`/ssh settings (`config`), a live read-only status panel with plain-word phases, temperature, fan cues and every shot's outcome (`watch`), the hunter wired to the profile (`hunt`), and the outcome ladder (`ladder`, `classify`); see `docs/CIMP.md` |
| `tools/hunter/goldilocks_hunt.py` | The goldilocks hunter: plans each phase of `docs/SWEET_SPOT.md` (community train ladder, fuse-read window map, init-phase release-edge scan, slow-slew edge scan, dwell, and the push3 overlap edge) with every step checked against push2's release rule (or push3's, for plans that opt in), drives `bootrun.sh` through a plan (dry run unless `--execute`, stops on poison, latch, holds and unknown outcomes), and tallies runner logs per cell (counts, GFW/DSOV/CRC/mask/sentinel codes, edges, partial CRC codes, the first shot of each boot left out) into the next phase. Never senses or burns; standard library only |
| `tools/runner/` | The push2 per-boot runner (`bisect_shots.py`), park and preflight, and the launchers: `bootrun.sh` (power cycle, fresh-boot guard, plan checksum, host guard, preflight, identity, temperature gate, runner, hold hook), `firstshot.sh` (one fresh boot per step) and `campaign.sh` (a ladder across boots), as the lab ran them; see `docs/RUNNER.md`. Since 2026-11-21 the runner also has the lab's behaviour from cards G and H: read-only stall reads, compass frames, no parks with a 100 ms `PEX_RST` recovery and a healthy-read gate, opt-in shooting through stalls and partials, the sentinel rule for DSOV 0, and a machine-readable line per shot |
| `tools/planner/` | The planner and hunter: an append-only shot ledger, a log parser, a next-shot planner (loss island, delay sweep, CRC compass, drift loop) under never-rules, and `hunt.py`, which runs plan, launch, ingest in a loop with stop rules (dry run unless `--execute`). Example card and family files, an empty ledger and a small synthetic sample; see `tools/planner/README.md` |
| `tools/hostsim/` | Host simulation of the firmware's shot timeline: compares push2 and push3 shot by shot (`run.sh`, 90 checks) |
| `tools/diag/` | Two gentle 700 mV checks: where the `PEX_RST` release lands per kind of shot (`timing_controls.py`), and whether EN_SW_OVERRIDE survives `PEX_RST` (`enswtest.py`) |
| `tools/vfi_preflight.py` | Read-only checks before a session: firmware marker, who controls the rail, the card's six VRM profile registers (stops on a leftover fast value), host lockdown, driver, config space, FUSECTRL, GFW boot progress |
| `tools/vfi_park.py` | Hold NVVDD at stock under PMBus, pulse PEX_RST, wait, read config space, hand the rail back |
| `tools/vfi_rescue.py` | The same sequence step by step with diagnostics, for a card whose link is gone after a crash |
| `tools/fuseplan/` | Offline fuse planner (`fuseplan.html`, one file, no network): SM and memory ceilings, the 80 GB check, the PCIe fields and, from a complete read, the FF record words in the lab order with a simulation and an export for `ffcalc sim`. Computes only; matched the lab's burned records on its seven cards |
| `tools/vfi_snap.py` | Register snapshot (fuse status, gates, SM count, FB partitions, the PCIe option words) to a 0600 JSON file; `--rows` adds two passes over the 512 fuse rows with the controller's READ command |
| `tools/vfi_trace.py` | NVVDD trace capture per shot with its outcome (debug firmware), back-to-back or first-shot mode |
| `tools/vfi_hunt.py` | Stop-and-hold hunter: shots at one setting until a clean goldilocks, which it leaves held |
| `tools/vfi_edge.py` | Edge tracker: walks the train timing along a card's lethal edge in short cells, with a crash budget |
| `tools/vfi_common.py` | Shared code: park, poison-safe classify, bounds, the no-dip check, per-boot shot ledger |
| `tools/pcie/` | After the burn: PCIe Gen3, then Gen4, at every boot on finished cards, as the lab runs it on its EPYC server. A systemd service with a crash-loop guard, the driver walk to Gen3 (`cmp-rmwalk`), the seven E1 PHY writes with single 32-bit stores (`cmp-e1steps`, refuses a card whose `OPT_PCIE_BOOT_GEN23_DIS` is still set), one retrain to Gen4, a Gen3/Gen4 switch and a link monitor; see `tools/pcie/README.md` |
| `driver/` | After the burn: `fb-geometry-80g.patch` for the cmpunlocker driver (open-gpu-kernel-modules 615.71.09). It gives a card 80 GiB only when the card's own masks show 10 of 12 FB partitions active, keeps 64 GiB otherwise, with a kill switch and a log-only mode; see `driver/README.md` |
| `tests/` | Offline tests against a simulated Pico, voltage controller and card, a fake `ga100vfi` package for the runner, fake `ssh`/`scp`/power tools for the launchers, and a fake sysfs, BAR0 and `setpci` for `tools/pcie/` |
| `docs/GUIDE.md` | Start here: the whole route from candidate card to Gen4 x16 at 80 GiB, in order, with checklists, the troubleshooting table and where to read more |
| `docs/ALLSPARK.md` | Petri Krohn's complete CMP 170HX to A100 unlock guide (2026-11-18 to 2026-11-20): RIR and voltage-glitch gates, BAR0 fuse-write mechanics, ordered FF and column burns, A100 VBIOS cross-flash, ECC, MIG, vGPU, SR-IOV and recovery |
| `docs/OVERLAP_EDGE.md` | What finished card E: the map of the release-edge window push3 opened, the shot, and how to scan it on another card |
| `docs/PUSH3.md` | The push3 firmware change: what changed, why it is safe, how it was checked, how to flash it and the BOOTSEL trap |
| `docs/CIMP.md` | CiMP: commands, every setting, profiles, environment variables, ssh keys and passwords, the watch panel |
| `docs/SWEET_SPOT.md` | The strategy that finished cards G and H, in order, with both cards as worked examples and their data: the community train, the fuse-read map, the init phase, the slow slew, the hold |
| `docs/METHOD.md` | How the lab searches now, and why: on-time release first, park-normalized shots, slow slew and a lower restore against link loss, restore 588 mV against the controller latch, delay as a knob and the 47 µs rule, CRC as a compass, what one card showed, the search order that worked best |
| `docs/MEASUREMENTS.md` | What the bench measured: write time, release slip, the 36 µs width floor, EN_SW_OVERRIDE, sticky poison, the controller-off latch |
| `docs/RUNNER.md` | How to use the runner and the launchers |
| `AGENTS.md` | Instructions for an LLM agent that runs the bench: the rules, a first-session walk-through, the loop, exit codes, talking to the person at the bench, holds, troubleshooting (`CLAUDE.md` and `GEMINI.md` point to it) |
| `docs/AUTONOMOUS_AGENT.md` | Running the bench with an LLM agent: access, the loop, the goldilocks hunter's loop and stop rules, the guard rails, what stays with people |
| `docs/UPSTREAM_PR.md` | Pull request text for the firmware patches |

## Setup

Hardware, wiring and probe placement: see the
[method page](https://cmp.wiki/wiki/Voltage-glitch_unlock:_lab_method_on_a_Pico_2_W#Parts_and_host). In short: a
Raspberry Pi Pico 2 W class board (RP2350), four needles on the back of the card (SDA, SCL, PEX_RST_BUF*, ground),
an optional fifth on NVVDD for the debug build's ADC. No soldering. Take the NVVDD lead off while you glitch: on the
lab's bench an attached lead made one card crash 30 to 70 mV earlier.

Host, before the first shot:

1. Secure Boot off. `/sys/kernel/security/lockdown` must show `[none]`, or every BAR0 and config write is refused.
2. No NVIDIA driver near the card: bind `10de:20c2` to `pci-stub` and keep `nvidia` blacklisted on the glitch boot.
   A driver build that applies fuse overrides at probe time can write to a card whose DSOV reads 0.
3. Boot with `pci=noaer`.
4. Memory decode on for a cold card with no driver (`vfi_preflight.py --enable-decode`, or
   `setpci -s <bdf> COMMAND=0x0002`).

Firmware and host package:

```sh
git clone https://github.com/dalzyu/pico-ga100vfi && cd pico-ga100vfi
git checkout e1ebd97                       # the base these patches were made against
git am /path/to/cmp170hx-8gb-vfi-tools/firmware/*.patch
# build per docs/BUILD.md, e.g. for an official Pico 2 W (RP2350A):
#   cmake -S firmware -B build -G Ninja -DPICO_BOARD=pico2_w -DBOARD_RP2350A=ON [-DDEBUG=ON]
python3 -m venv ~/vfi-venv && ~/vfi-venv/bin/pip install ./host
```

Flash the Pico before any lead touches PEX_RST. With all twelve patches the firmware reports `fw=lab-psr1-push3`
(`-debug` in the debug build; patch 0012 changes only the host package). The debug build (`-DDEBUG=ON`) is needed only
for NVVDD traces; it samples NVVDD on GP26 on RP2350A boards (GP42 on RP2350B).

## Use

Every tool takes `--bdf` (the card's PCI address) and `--port` (the Pico's serial port), or reads `VFI_BDF` and
`VFI_PORT`. Run as root, with the venv's Python:

```sh
export VFI_BDF=0000:05:00.0                                # yours: lspci -Dn -d 10de:20c2
export VFI_PORT=/dev/serial/by-id/usb-Raspberry_Pi_...     # yours
PY=~/vfi-venv/bin/python

sudo -E $PY tools/vfi_preflight.py --bdf $VFI_BDF --enable-decode
sudo -E $PY tools/vfi_snap.py --rows --label cold-baseline       # keep this file private
sudo -E $PY tools/vfi_hunt.py --v-dip 356 --budget 200            # stops and holds on a clean goldilocks
sudo -E $PY tools/vfi_snap.py --label held                       # read the held state
# After a hold, stop here: the park below drops the held state. Park only when you are done with it.
sudo -E $PY tools/vfi_park.py                                     # always end here
```

The goldilocks hunter (`docs/SWEET_SPOT.md`), from the machine that runs `bootrun.sh`:

```sh
H=tools/hunter/goldilocks_hunt.py
python3 $H strategy                                       # the strategy and the stop rules
python3 $H train --out plan-train.json                    # phase 2: the community train, shallow to deep
python3 $H run plan-train.json --card example             # dry run; add --execute --log-dir logs/train to shoot
python3 $H tally logs/train                               # the map and the next phase (readmap, init, slow, dwell)
```

More examples:

```sh
# first-shot mode: park before every shot
sudo -E $PY tools/vfi_hunt.py --v-dip 331 --t-dip 0 --budget 100 --first-shot
# edge tracker: 10-shot cells, start on the safe side, rotate two depths
sudo -E $PY tools/vfi_edge.py --v-dips 356,356,362 --t-dip-start -140 --crash-budget 60
# NVVDD traces (debug build), two cells, five shots each
sudo -E $PY tools/vfi_trace.py --out traces.json --shots 5 338:-60 331:0
# link gone after a crash
sudo -E $PY tools/vfi_rescue.py
# the lab's per-boot runner, by hand: a ladder in 5-shot cells, park before every shot (docs/RUNNER.md)
sudo -E PARK_EACH=1 $PY -I tools/runner/bisect_shots.py 'card X' '[[450,-60,3,198,750,1,2],[381,-60,3,80,750,0,5]]'
# the same at a 330 us delay (step fields 11 and 12 are delay and gap)
sudo -E PARK_EACH=1 $PY -I tools/runner/bisect_shots.py 'card X' '[[381,-60,3,80,750,0,5,0,-20,0,330]]'
```

Exit codes of `tools/vfi_*.py`: 0 done (or goldilocks held), 1 nothing found or a check failed, 3 stopped by a
safety check (the message says which), 4 park or rescue failed, 5 serial or sysfs error. The runner and the
launcher have their own (`docs/RUNNER.md`).

If one CPU core of your host is suspect, the tools run fine under `taskset`.

## Running a campaign unattended

`tools/runner/bootrun.sh` runs one boot per call: power cycle (Wake-on-LAN or IPMI), fresh-boot guard, plan
checksum, host guard, preflight, card identity, temperature gate, then the runner with a time limit. When the runner
holds a goldilocks, the launcher runs your `ON_HOLD` command if you set one, and otherwise stops and reports. Hosts,
addresses and the card table live in `tools/runner/bench.conf` (start from `bench.conf.example`). `firstshot.sh`
runs one fresh boot per step and `campaign.sh` walks a ladder across boots. `tools/planner/hunt.py` plans the next
shots from a ledger of every earlier shot, runs a launcher, reads its log back and plans again, inside a budget and a
set of stop rules. The lab drove this loop with an LLM agent first; `docs/AUTONOMOUS_AGENT.md` describes what the
agent gets, the loop, the guard rails and what stays with people.

## Shot outcomes

| Outcome | What the reads show | Meaning |
|---|---|---|
| under | DSOV still 1 (the runner also wants CRC `0x55` and a full privilege mask) | dip too shallow, or at the wrong time |
| CRC moved | DSOV 1 and CRC `0x77` (closed) or `0x75` / `0x57` (adjacent) | the shot reached the fuse read's CRC; densify here (`docs/METHOD.md`, section 6). Read as four 2-bit fields, `0x57` is block 0 failed, `0x75` block 2 failed, `0x77` both (`docs/SWEET_SPOT.md`) |
| stall | GFW boot progress not done after the shot; a read-only stall read logs FUSECTRL, DSOV, CRC, the mask and the sentinel | the glitch landed in the fuse read or the GPU's init; a stall with DSOV 0 is held, and by default a stall ends the boot |
| over | DSOV 0, CRC not `0x55` | too deep |
| hit | DSOV 0 and CRC `0x55`, another check fails (usually the privilege mask) | close, not burnable |
| goldilocks | DSOV exactly 0, CRC `0x55`, privilege mask `0xFFFFFFFF`, FPF row readable (and the DSOV write-back, when `CLASSIFY_WRITE=1`) | the target state |
| lost | no link after the shot | the GPU crashed; the next park or shot resets it |
| nack | the voltage controller did not answer on I2C | seen only at crash-prone settings: a crashing GPU disturbs the shared I2C bus |
| poisoned | FUSECTRL or DSOV `0xBADFxxxx` | the dip disturbed the fuse read itself; nothing else is read. It stays poisoned until a power cycle, or until a 100 ms reset once GFW is ready with `POISON_RESET=1` ([`docs/RUNNER.md`](docs/RUNNER.md)); otherwise end the boot |
| fuse unit error | a `0xBAD0xxxx` read (seen at FUSECTRL) | the fuse unit did not answer; nothing else is read. On one card about 1 to 2 % of shots at large delays, never on an exact repeat |
| mistimed | the release was not 0 to 4 µs after t = 0 by the alarm, or a write crossed it | the shot is read but not scored; the runner stops |
| no dip | the reply shows `pwd=0` or `e1` other than `0xc2fa` | the controller dropped the dip writes; the shot did not run |
| controller off | STATUS_WORD `0x2042`, READ_VOUT about 41 mV | the MP2888B turned its output off; no core power until a power cycle |

A poisoned shot read with the stock classifier shows DSOV 0, CRC 0 and privilege mask 0 because nothing was read.
Count a real DSOV flip only when the privilege mask is nonzero. One card here gave about 600 "hit" shots with the
privilege mask stuck at `0xFFFFFEFE`; a sense on one of them poisoned the controller. Wait for the full mask.

## What moves the window

- **First shot versus back-to-back.** The campaign leaves the rail under PMBus control between shots (`revert=0`).
  The first shot after a park starts from the GPU's own PWM-VID control instead, and its trough measured about
  40 mV shallower (270 against 230 mV on the Pico ADC). The two behave like two different settings. One card's
  second goldilocks was the first shot of a cell, right after a park; on another card the lethal timing edge moved
  about 45 µs later in first-shot mode, and on a third, with push2 releasing both on time, 350 mV was under as the
  first shot and lost the link as the second. `--first-shot` (tools) and `PARK_EACH=1` (runner) park before every
  shot, which made later shots behave like first shots.
- **Timing is a continuous knob, with one trap.** `t_dip` sets when the pulse train starts relative to the PEX_RST
  release (tool default -60 µs) and moves in 1 µs steps; depth moves in 6.25 mV controller codes (354 and 356 mV are
  the same code). One card's DSOV flip had a 4 µs wall (-66 µs never flipped, -62 µs did). Another hit after the
  standard 3 x 198 µs train was slid 60 µs later. The trap: the firmware cannot release `PEX_RST` while a voltage
  write is running, so a shot whose write overlaps t = 0 releases late (up to about 60 µs), and a timing map across
  that region moves the release along with `t_dip`. The default train at -60 µs releases on time. Table in
  `docs/MEASUREMENTS.md`. Pulse widths below 36 µs are sent as 36 µs.
- **Temperature.** Let the card settle at its normal idle temperature and hold it there with a fan. Cooling moved
  one card's edge up one code, 43.7 C moved it down, and at 47-49 C every shot was lost. The hits here came at about
  36 to 40 C, read from the controller's own sensor (READ_TEMP1, taken as 0.1 C per bit; the scale is not
  confirmed, so watch the trend, not the number).
- **Shots per boot.** The lab kept to about 200-450 shots between host reboots, in line with community reports
  that nothing hits after about 500 shots on one boot. Every tool that glitches counts shots and lost shots per
  host boot (`--max-shots-per-boot`, default 450; `--max-lost-per-boot`, default 150) in `--state-dir`, and stops at
  the cap. `vfi_edge.py` adds a per-run `--crash-budget` (default 60); the runner has `SHOTCAP`.
- **Pulse length, restore level and the controller-off latch.** On one card, 3 x 198 µs trains at 381 mV with
  restore 750 mV latched the controller off, while trains of 80-120 µs pulses at 388-356 mV did not, and with
  restore 588 mV the 3 x 198 µs train ran from 381 down to 331 mV with a single latch. Start a new card shallow and
  step down.
- **Delay.** `t_dip` and `delay` reach the firmware only as `t_dip - delay`, so delay is one more timing knob, and a
  write must never be in flight across the release (about 47 µs per write), which rules out some delays for each
  train. Hits reported by others sat at delays of 330 to 360 µs; the lab had used 117 µs throughout until
  2026-11-20 (`docs/METHOD.md`, section 5).
- **Recovery and the PCIe link.** On one card a gentler recovery after the dip (stock slew, or restore 625 mV
  instead of 750 mV) kept the link one VID step deeper; on another card a higher restore (800 to 825 mV) did, so try
  both directions. Below about 325 mV commanded the first card's GPU dropped off the bus in every form tried, a dip
  entirely before the release included.
- **Cards differ.** Commanded depth at the hit ranged from 300 to 356 mV across sessions and cards. One card never
  reached goldilocks in about 4,000 shots: it went from under straight to a crash at every depth and timing tried,
  with the fuse read and the lethal event inside the same few microseconds. Details on the results page.

- **One-step dither (`revert` 2).** The firmware can step a dip between two adjacent VID codes, 6.25 mV apart, to
  land between them: even pulses at `v_dip`, odd pulses one code shallower, no restore in between, each step at least
  one 47 µs write (patch `0008`, [`docs/RUNNER.md`](docs/RUNNER.md)). On card E it ran in the form push2 allows, the
  deep code first and the shallower one ending just before the release: every shot came back under. It moved no card
  off its ladder and finished none. What worked between codes was timing on card E (push3) and the ramp on card C
  (a slow ramp at the shallower code). push3 also makes a dither that holds the rail low across the release legal;
  the lab has not run one on a card.

## Safety behavior

- **Park before config reads.** A crashed GA100 under its own PWM-VID control asks for the ~0.3 V floor, and every
  PEX_RST then reboots it into a brown-out; a half-booted card can also answer config reads with CRS, which an
  Intel root complex retries forever (the lab's reading of three silent host freezes, each on a config read right
  after a handback). Park holds the rail at stock
  787.5 mV under PMBus and checks READ_VOUT before it pulses PEX_RST and reads config space. If the link does not
  come back while held, the rail stays held and config space is not read again; if the GPU asks for the floor
  after the handback, the rail is taken back. Every tool that glitches parks at the start, between cells and on
  exit (also on Ctrl-C or a safety stop), except when it holds a goldilocks.
- **Poison-safe reads.** FUSECTRL is read first after every shot and in the snapshot; on `0xBADFxxxx` or
  `0xBAD0xxxx` nothing else is read, and the same holds for a `0xBADF` DSOV (patch 0005). The runner and
  `passive_snapshot.py` (patch 0010) also stop at any `0xBAD0xxxx` read and at a FUSECTRL other than the idle
  `0xE0040000`. A poisoned controller stays poisoned until a power cycle, so a poisoned shot ends the run: the
  runner's boot ends, and `vfi_hunt.py`, `vfi_edge.py` and `vfi_trace.py` stop and park the card.
- **Rail check before config reads.** With `--port` (or `VFI_PORT`), `vfi_snap.py` reads the rail over I2C first and
  does not touch config space when READ_VOUT is below 500 mV, whoever owns the rail.
- **Stalls.** A GFW that is still booting after a shot gets one read-only stall read (FUSECTRL first) and, by
  default, ends the boot without another `g`, `r`/`j` or FLR, as upstream's rule 2 asks. `SHOOT_THROUGH_STALLS=1`
  breaks that rule on purpose and is off unless you turn it on.
- **Release timing.** push2 refuses any shot with a write in flight across the `PEX_RST` release, keeps the card in
  reset when a step fails, and the runner refuses to score a shot that was not released on time.
- **No EN_SW_OVERRIDE writes.** The stock classifier wrote `0x820040` (EN_SW_OVERRIDE) after every shot, and that
  bit survives PEX_RST. With patch 0005 the classifier only reads it, unless you set `CLASSIFY_WRITE=1`.
- **Check that the shot ran.** After every shot the reply must show `pwd=1` and `e1=0xc2fa`; a locked controller
  acknowledges the dip writes and discards them, and the shot would read "under".
- **Firmware and profile checks.** With the fast VRM profile, the tools refuse firmware without the profile
  save/restore patch (stock firmware writes its author's VRM table onto your card after every shot) and refuse to
  start when one of the six profile registers holds its fast value (an interrupted shot: power the card fully off).
- **Bounds.** The firmware has no voltage limits of its own. The tools accept dips of 280-400 mV, recovery of
  550-800 mV, 1-5 pulses of 36-400 µs and `t_dip` within ±1000 µs, and stop otherwise. The runner refuses dips below
  `FLOOR` or above 825 mV and recovery outside 575-825 mV, and the hunter's step check refuses the same; a bad step
  stops the runner before the first shot with a `STOP: step ...` line and exit 2.
- **No driver, no lockdown.** The tools stop if the card is bound to anything but `pci-stub` (or nothing), if the
  `nvidia` module is loaded while the card is not held by `pci-stub`, or if kernel lockdown is on. `bootrun.sh` also
  stops when `nvidia` or `nouveau` is loaded at all, checks from sysfs that a configured `bdf` is a `10de:20c2` card
  before any config access, and turns on only the memory-decode bit.
- **Reads only.** The snapshot is BAR0 reads only by default. `--rows` writes nothing but FUSEADDR and the READ
  command to FUSECTRL, behind an allowlist, never DEBUGCTRL, and restores FUSEADDR. Fuse dumps and the upstream
  campaign's goldilocks log identify the card: keep them private. `tools/diag/enswtest.py` writes EN_SW_OVERRIDE on
  purpose (that is what it tests) and says so.
- **Right card, by die ID.** With `DIE_DUMP` set for a card, the launcher reads fuse rows 8 to 15 (the die ID;
  READ command only, FUSEADDR restored) after the identity check and stops (exit 5) when they differ from that plan
  dump (one with `ff_rows`, or a `vfi_snap.py --rows` file; one whose two passes differed is refused); it prints row
  numbers, never the values. `vfi_snap.py --die-id DUMP` is the same check by hand.
- **The firmware's `u` command** writes the voltage controller's unlock and config-id, as upstream documents. The
  tools use it to take the rail under PMBus control for park and rescue; nothing else is written to the controller
  except through the firmware's own glitch command.

## Status

- `firmware/0001-0003` rebuild the firmware the lab ran on its cards up to 2026-11-19 (the debug build is
  byte-identical; the normal build differs only in its embedded build date). With `0004` the firmware is the timing
  build the lab ran from 2026-11-20. `0005` is the classifier the lab's bench used from 2026-11-20.
- `firmware/0006-0010` are push1 and push2 as the lab ran them on one card on 2026-11-20 (push2 for about 500
  shots), except that the unlock readback of `0007` is arranged differently (see `firmware/README.md`), so the
  builds differ from the lab's by checksum.
- `tools/runner/` and `tools/diag/` are the scripts the lab ran on its bench on 2026-11-19 and 20, with the bench's
  hosts, addresses, paths and card table turned into settings, and the launcher's burn hand-off replaced by the
  `ON_HOLD` hook. They pass the offline tests in `tests/`; they had not run in this exact form when published
  (2026-11-20).
- `tools/planner/` is the lab's planner and hunter with its ledger left out; it planned from the lab's logs and
  passes its offline tests against a fake bench. It had not run unattended on a card in this form when published.
- `tools/hunter/` and the runner's additions of 2026-11-21 follow the lab's runner and its strategy for cards G and H
  (2026-11-20). They pass the offline tests, and the tally reproduces both cards' maps from the lab's logs; they had
  not run on a card in this form when published (2026-11-21).
- `firmware/0011` is push3 as the lab ran it on card E on 2026-11-21 (13 shots, 10 of them overlap shots, every release at t = 0 by the
  alarm, the goldilocks on the 13th), applied to this series; it builds with no warnings and passes the host
  simulation (90 of 90). The lab's image was built from its own push2 tree, so checksums differ (as for `0006-0010`).
- `firmware/0012` (2026-11-22) makes `Bar0.wr32` one aligned 32-bit store: `struct.pack_into` wrote `0x00000000`
  to the register before the value. Host only; with all twelve applied, this repo's tests pass.
- The die ID check (`DIE_DUMP`, `vfi_snap.py --die-id`), `vfi_snap.py` exiting 1 on an untrusted row read, and the
  hunter, runner and `cimp` fixes of 2026-11-22 pass the offline tests (149 with the twelve patches). The die ID check
  follows the lab's bench check of the same day; neither had run on a card in this form when published (2026-11-22).
- `cimp` and the runner and launcher additions of 2026-11-21 (the `tv` step field, `SENT0_CONTINUE`, per-poll gate
  lines and `TSTART`, `POWER=manual`) are new: `cimp watch` was checked against the lab's real logs, including card
  E's winning run, and everything passes the offline tests; the configurator, `hunt run` and the launcher additions
  had not driven a bench in this form when published (2026-11-21).
- `POISON_RESET` and the temperature-gate fix of 2026-11-21 follow the lab's bench patch, which cleared 64 of 64
  poisons in one 129-shot boot on card C (card C's winning shot came before any reset). The published version passes
  the offline tests and had not run on a card in this exact form when published (2026-11-21).
- `tools/vfi_*.py` are cleaned-up, generic versions of earlier bench scripts. They pass the offline tests and had
  not run on a card in this form when published (2026-11-19).
- `tools/pcie/` (2026-11-25) is the boot service and scripts the lab's EPYC server has run at every boot since
  2026-11-22, with its paths turned into settings and the service renamed. Two refusals were added to `cmp-e1steps`
  (a card whose `OPT_PCIE_BOOT_GEN23_DIS` reads 1, or whose DSOV bit 0 reads 0); the boot service already skipped the
  first. They pass the offline tests (`tests/test_pcie.py`); they had not run on a card in this exact form when
  published.
- `driver/fb-geometry-80g.patch` (2026-11-25): its geometry code is byte-identical to the code in the driver the lab's
  EPYC server runs on seven 80 GB cards (built on the Morrowmake fork of cmpunlocker). On mainstream cmpunlocker
  `2c7e2ec` it applies with no fuzz and builds with no new warnings; a module built that way had not been loaded on a
  card when published.

Reports welcome.

## Tests

The tool tests need the ga100vfi host package from a pico-ga100vfi clone with the patches applied (it imports
pyserial):

```sh
GA100VFI_HOST=/path/to/pico-ga100vfi/host python3 -I tests/test_tools.py
GA100VFI_HOST=/path/to/pico-ga100vfi/host python3 -I tests/test_runner.py
python3 -I tests/test_launchers.py
python3 -I tests/test_hunter.py
python3 -I tests/test_cimp.py
python3 -I tests/test_pcie.py                             # tools/pcie/, no hardware, about 50 s
tools/hostsim/run.sh /path/to/pico-ga100vfi HEAD~2        # with 0001-0012 applied: push2 (0010) against push3
(cd tools/planner/tests && python3 -I -m unittest discover -s . -t .)
(cd /path/to/pico-ga100vfi/host && python3 -m unittest test_classify test_passive_snapshot test_serial_response)
```

## Upstream

The patches are meant for upstream; `docs/UPSTREAM_PR.md` has the pull request text. They are made against
pico-ga100vfi `e1ebd97`. Upstream has rewritten its history before; if `git am` fails on a newer checkout, the
changes are small enough to apply by hand.

## Credits

[kate-land](https://github.com/kate-land) for the GA100 voltage-glitch method and the original
[ga100vfi](https://github.com/kate-land/ga100vfi) tooling; [dalzyu](https://github.com/dalzyu) for
pico-ga100vfi, which these tools drive; [mellojello_](https://github.com/JosiahWhite) for proving the I2C and
PEX_RST path; [sayhellotojungle/esp32-ga100vfi](https://github.com/sayhellotojungle/esp32-ga100vfi) for the note
that a locked controller silently drops dip writes; the members of the cmpunlocker Discord whose reports are
credited on cmp.wiki.

## License

MIT, as upstream. See `LICENSE`.
