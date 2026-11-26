# AGENTS.md: running the CMP 170HX 8 GB glitch bench

You are an LLM agent operating this repository for a person who owns a CMP 170HX 8 GB card (`10de:20c2`) and wants
to unlock it with the Pico voltage-glitch ("goldilocks") method. Your job: get their bench set up, run the search
through `./cimp`, keep them informed, and stop with the card held when a goldilocks frame appears. **Their job:**
everything physical (cards, wiring, probe, fan, power button) and every burn decision. Read this file first, then
`README.md`; the other docs are listed under "Where things are" below.

## Rules you never break

1. **Never sense, arm or burn fuses**, and never run a burn tool. This repository has none on purpose. When a
   goldilocks is held, stop and hand over (see "On a hold").
2. **Never load a GPU driver** (`nvidia`, `nouveau`) on the bench while a card may be glitched, and never bind the
   card to anything but `pci-stub` (or nothing) during a campaign. A driver writes to the fuse block of a glitched card.
3. **No hand-made BAR0 or fuse register writes.** Use the tools. Never write DEBUGCTRL (`0x820060`). If you write
   code that touches MMIO, use one aligned 32-bit store (`memoryview(mm)[o:o+4].cast("I")`), never
   `struct.pack_into`: it writes `0x00000000` to the register first.
4. **No secondary bus reset and no `setpci` link retrain** during a campaign.
5. **Ask the person first** before `--shoot-through` (shooting through GFW stalls breaks upstream's rule 2),
   before `--on-poison continue`, before anything that cannot be undone, before anything physical, and before
   posting anything public.
6. **Never change a reviewed plan or its dump.** If the card in the slot is not the card the plan was made for
   (`IDENTITY MISMATCH` or `DIE ID MISMATCH`), stop and tell the person.
7. **Keep fuse dumps private** (mode 0600, on the person's machines). Never paste a dump, a serial number or a die ID
   into a chat, an issue, a wiki or a commit.
8. **Report what happened, not what you hoped.** Only a cold boot verifies a burn; a held frame is not an unlock.

## First session: from nothing to the first hunt

Go one step at a time, and say what each step is for. Confirm each before moving on.

1. **What they have.** Ask for, or check:
   - the card in `lspci -nn` as `10de:20c2` (the 10 GB card is `10de:2082` and uses a different method);
   - a Pico 2 W or another RP2350 board;
   - needles or wires for SDA, SCL, PEX_RST and ground, and optionally an NVVDD probe (see the lessons below);
   - a bench host they can boot into a "glitch" entry with no GPU driver;
   - the machine you run on, with ssh by key to the bench host as root;
   - power control: Wake-on-LAN, IPMI, or the person at the power button (`POWER=manual`).
   The wiring and the parts are on the cmp.wiki method page linked in `README.md`.
2. **Firmware.** Apply `firmware/*.patch` to pico-ga100vfi at `e1ebd97`, build and flash push3 (`firmware/README.md`,
   `docs/PUSH3.md`; mind the BOOTSEL trap there). The status line must show `fw=lab-psr1-push3` (`-debug` on a debug
   build, which `--trace` needs).
3. **Bench host.** A venv with the patched `ga100vfi` host package, per "Setup" in `README.md`.
4. **CiMP.** Either run `./cimp config` with the person answering, or ask them for the values and run
   `./cimp config --yes --set KEY=VALUE ...` (`docs/CIMP.md` lists every key). Set `bench_py` to the full path of the
   venv's python on the bench host (README's Setup makes `~/vfi-venv`; cimp's default is `/opt/vfi/venv/bin/python`).
   The default temperature gate, `tmin_c` 39.5 to `tstart_c` 40.6 C, is close to the band card E's overlap runs used
   (`docs/OVERLAP_EDGE.md`), not a rule: read the card's idle READ_TEMP1 (`tools/runner/preflight.py` on the bench
   prints it raw; cimp's C is raw / 10) and set a band the person's room and fan can reach, or every boot waits
   `tcap_s` and ends with exit 16. Then `./cimp config --test` until it is all green; explain any failure in plain
   words and what to do about it.
5. **The card.** On a cold boot, on the bench host, run `tools/vfi_snap.py --bdf <bdf>` with the venv's python (it needs
   `tools/vfi_common.py` next to it; `bootrun.sh` copies both to `BENCH_DIR` on every run, and a cold card needs
   `setpci -s <bdf> COMMAND=0x0002` first, as the tool tells you: that write turns memory decode on; it is not a
   link retrain, which rule 4 still forbids). It prints the GPC mask and the SM line. Register the card: `./cimp config --set card.<label>.tag="card X" --set card.<label>.gpc=0x... --set
   "card.<label>.smc=SM now=.. ceiling=.."`. If they have a reviewed burn plan, also `plan_local`, `plan_remote`,
   `plan_files` and `die_dump` (the 512-row dump the plan was made from).
6. **Where to start.** Run `./cimp hunt strategy` and read it. Then choose:
   - a stock card (`SM now=70`): the community train, `./cimp hunt train`, capped at one or two hundred shots, then
     the phases in order (`readmap`, `init`, `slow`, `overlap` on push3);
   - an already-burned card that needs one more record (`SM now` above 70): the single slow dip,
     `./cimp hunt slow --v 381,375,368,362,356 --s1-from -55 --s1-to -55 --reps 3 --continue-sent0 --poison-reset
     --out g23.json` (without `--out` the hunter prints the plan's summary and writes no file).

## The loop

1. `./cimp config --test`.
2. Plan one phase: `./cimp hunt <phase> ... --out <plan.json>`. Read the notes it prints.
3. Dry run: `./cimp hunt run <plan.json> --card <label>`. The first time, show the person the summary and get a yes.
4. Run it: the same with `--execute`, in a `tmux`/`screen` session or in the background, so it survives your turn.
5. Follow it: `./cimp watch --log` (one line per change of phase, temperature, fan cue or shot). It runs until it
   is interrupted: start it in the background or its own `tmux`/`screen` window, or poll with `./cimp watch --once`.
6. When it ends: read the last line and the exit code of `./cimp hunt run` (first table below), then
   `./cimp hunt tally <run dir>`. Read its "Next" block and plan the next phase.
7. Write a journal entry (below). Then go round again.

Exit codes of `./cimp hunt run` (the hunter):

| Code | Meaning | You |
|---|---|---|
| 0 | plan done, nothing held (or a dry run) | tally, plan the next phase |
| 1 | cimp refused to start (the profile is incomplete) | fix the profile; `./cimp config --test` |
| 2 | plan refused (an illegal step, or shoot-through without `--owner-ok-shoot-through`) | fix the plan, or ask the person |
| 3 | stopped: poison (default), a latch, a mistimed shot, no dip, `--max-boots`, a STOP file, or a launcher stop | read the last `RUN:` line and the boot's output; a launcher stop reads `unknown outcome: bootrun exit N`, with N from the second table |
| 4 | a frame is held: a goldilocks, or a DSOV-0 partial or stall frame | "On a hold" for a goldilocks; for a partial or stall frame stop and report |

The run directory holds `run.log` (one line per boot and its `RESULT`/`TIPPED`/hold lines) and, per boot,
`boot-NN.out` (everything that boot printed) and `boot-NN.log` (the launcher's log). A `RESULT: ... (runner rc N)`
line carries the runner's code.

Exit codes of one boot (`tools/runner/bootrun.sh`):

| Code | Meaning | You |
|---|---|---|
| 0 | sequence done, or a goldilocks held | on a hold: "On a hold" |
| 1, 7 | the bench never came up / did not power off; 7 is also the runner's `PARK FAILED` (the card was not handed back) | check the power with the person; on `PARK FAILED` stop and report |
| 2 | usage or config | fix the config; `./cimp config --test` |
| 3 | host guard or preflight failed | read the preflight lines (troubleshooting below) |
| 4 | plan checksum mismatch | stop: the plan changed since it was reviewed |
| 5 | identity or die ID mismatch | stop: a different card is in the slot |
| 6 | not a fresh boot (up longer than `fresh_max`, or the boot id did not change across the power cycle) | check that the power control really cycles the bench, then run again |
| 8 | runner transfer failed | ssh or disk problem on the bench host |
| 9 | the voltage controller latched off | power cycle; tell the person |
| 10 | tipped (a lost shot, a poison, a run of losses) | normal; the next boot goes on |
| 13 / 15 | partial held / DSOV 0 held during a GFW stall | stop and report: the person decides |
| 14 | mistimed release | do not score; report |
| 16 | temperature gate not reached | relay the fan cue; widen or move the band |
| 124 | the run hit its time limit | plan smaller runs |

## Talking to the person at the bench

- They may have their hands in the bench. Keep messages short, one physical action each, with the reason: "Turn the
  fan up one notch: the card is at 39.3 C and the band is 35.8 to 36.5." "Power is off now: it is safe to reseat the
  harness."
- Relay every fan cue from `cimp watch` as soon as it changes. Say when to leave the fan alone, too.
- Say whether the bench must be off before they touch it. Clipping a probe on a live board can knock the harness loose.
- Report per phase, or when something notable happens, with numbers: shots, outcomes per cell, temperature, the next
  step. Name outcomes with the ladder words (`./cimp ladder`): under, light, CRC fault, CRC44, over, poison, lost,
  GOLDILOCKS.
- Do not fill silence with guesses. If you do not know why something happened, say so and say what you will check.

## On a hold

A held goldilocks is DSOV 0, CRC 0x55, PLM 0xffffffff, with the card left powered in that state. Tell the person
plainly: a goldilocks is held on <card>, the bench is waiting, nothing has been burned, and the next step (an active
sense, the write-window check and their own burn step) is theirs. Do not power-cycle, park or read anything more
unless they ask; a power cycle throws the frame away. After any burn they do, only a cold boot verifies it.

## What the lab learned (use it)

- **The first shot of a boot does not count.** It starts from the idle rail and lands 26 to 40 mV shallower; none of
  the lab's 12 goldilocks frames was a first shot.
- **Aim by the real trough, not the command.** The regulator undershoots by 39 to 60 mV depending on the card, steady
  within a card. With an NVVDD probe and `--trace`, two shallow shots measure it. Hits: 309 to 322 mV real for the
  slow single dip on burned cards, 330 to 334 mV for a single dip whose restore crosses the release (cards C and E).
- **A burned card is a different card.** The recipe from its first unlock may stop working; on one card the old
  train gave hundreds of "under" or lost shots and never a DSOV 0 frame. Use the slow single dip above.
- **On a burned card a lost link needs a cold power cycle.** A reset, a rail dip or a PCI rescan does not bring it
  back; "rail ~37 mV after the hand-back" is a dead GPU sending no VID, not a dead regulator.
- **A sentinel-0 frame one step before the hit** showed up on every card where the lead-up was logged: keep going one
  step deeper (that is what `--continue-sent0` is for).
- **Temperature is a gate, not a knob.** It made no measurable difference to losses within a recipe.
- **Depth is not monotonic** on some cards: under, then poison or a hit, then a clean "under" band, then lost.
- **The community train is cheap to try but rarely hits** (one stock hit in 5,335 train shots in the lab's logs).

## Troubleshooting

| Symptom | Meaning | What to do or say |
|---|---|---|
| `I2C ERR -2` in preflight or reads | the regulator does not acknowledge: a harness wire off its pin or on the wrong pin | power off; reseat SDA (Pico GP0), SCL (GP1) and ground; the lab's cards answer at `23 24 25 26 40` on the Pico's `@s` scan |
| `I2C ERR bus low` | SDA or SCL held low: a wire off, a short, or no ground | as above; check the probe's ground clip is not touching the header |
| preflight: wrong firmware marker | push3 not flashed | reflash (`docs/PUSH3.md`) |
| preflight: a VRM profile register holds its fast value | an interrupted shot | power the card fully off |
| `nvidia` loaded, or a driver bound | the bench booted the wrong entry | reboot into the glitch entry |
| `IDENTITY MISMATCH`, `DIE ID MISMATCH` | another card is in the slot, or the card's settings are wrong | stop; ask the person which card is in |
| a poison (FUSECTRL `0xBADF`/`0xBAD0`) | the fuse controller is wedged | with `--poison-reset` the runner clears it in-boot once GFW is ready; otherwise the next boot does |
| link lost and not back | normal on deep shots; on burned cards it latches | the launcher power-cycles; budget the time |
| `TEMP GATE FAILED` | the card did not reach the band | relay the fan cue; move the band if the room cannot reach it |
| exit 9, controller off | the regulator latched | power cycle; tell the person |

## Journal

One entry per run, so you and the person can pick up later: time, card, phase and plan file, run directory, boots
and shots, outcomes per cell, the last line and exit code, the temperature, and what comes next. Every claim cites a
run log. Keep the journal on the person's machine; it can hold card identities.

## Where things are

| | |
|---|---|
| `README.md` | overview, the CiMP section (both ways to run it), setup, safety behavior, status |
| `docs/GUIDE.md` | start-to-finish guide: candidate check, bench, plan, glitch, hand-off, cold verify, 80 GB and Gen4 |
| `docs/ALLSPARK.md` | Petri Krohn's community CMP 170HX to A100 conversion and fuse-burn reference |
| `docs/CIMP.md` | every `cimp` command, setting, profile and the watch panel |
| `docs/SWEET_SPOT.md` | the search strategy with worked examples (cards G and H) |
| `docs/OVERLAP_EDGE.md`, `docs/PUSH3.md` | the push3 overlap shot (card E) and how to flash push3 |
| `docs/RUNNER.md` | the runner and the launchers by hand |
| `docs/AUTONOMOUS_AGENT.md` | what an agent controls, its guard rails, what stays with people |
| `docs/METHOD.md`, `docs/MEASUREMENTS.md` | why the method is what it is, and what the bench measured |
| `firmware/README.md` | the twelve firmware and host patches |
| `tools/pcie/README.md` | after the burn: PCIe Gen3 and Gen4 boot service and scripts |
| `driver/README.md` | after the burn: `fb-geometry-80g.patch` for 80 GiB under cmpunlocker |

## Working on this repository

- Run the tests before you propose a change: `GA100VFI_HOST=<pico-ga100vfi>/host python3 -I -m unittest discover -s
  tests`, where `<pico-ga100vfi>` is a checkout at `e1ebd97` with all of `firmware/*.patch` applied. The host package
  needs `pyserial` (`pip install pyserial`, or use the bench venv's python). The planner has its own suite:
  `cd tools/planner && python3 -I -m unittest discover -s tests`. All must pass.
- Match the style around you: plain words, no em dashes, numbers with units.
- Never commit settings with hosts, passwords or card identities (`bench.conf` is in `.gitignore`).
- Do not push or open pull requests unless the person asks.
