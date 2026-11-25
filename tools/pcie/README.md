# PCIe Gen3 and Gen4 on a burned 8 GB card

These scripts take every burned CMP 170HX 8 GB card (`10de:20c2`) in a host from the Gen2 link the unlocker gives it to
Gen3, and then to Gen4 where the card's fuses allow it. They run once per boot from a systemd service, one card at a
time, with a guard that stops a card from taking the host down twice. The lab runs them at every boot on its dual-socket
AMD EPYC server.

Nothing here burns anything. Gen3 and Gen4 are volatile: the service redoes them after every boot.

On the lab's EPYC server, at every boot:

| | Gen2 x16 | Gen3 x16 | Gen4 x16 |
|---|---|---|---|
| Pinned host copies, per card | about 6.5 GB/s | about 13 GB/s | 22.4 to 25.1 GB/s |
| GPU to GPU (P2P), per pair | | 13.15 GB/s | 20.2 to 26.2 GB/s |

Six of its seven burned cards reach Gen4 x16 at each boot, 0 Xid, 0 AER. The seventh sits in a slot whose 16 GT/s
signal margin drops link equalization (it logs correctable errors even at Gen3); the guard keeps that slot at Gen3 x16.
What it is worth: a large model's cold prefill went up 15 percent from Gen3 to
Gen4; decode went up 0.3 to 1 percent (decode is not link bound).

## What the card needs

| Link | Fuses (FF records burned in the glitch session) | Driver |
|---|---|---|
| Gen3 | `OPT_DISABLE_GEN3_SPEED` (`0x820250`) and `OPT_PCIE_BOOT_GEN3_DIS` (`0x820580`) cleared | nvidia-smi reports max link gen 3 or more for the card |
| Gen4 | the above, `PCIE_MAGIC_BITS_D` bit 25 (`GEN4_SPEED_DISABLED`, `0x820520`) and `OPT_PCIE_BOOT_GEN23_DIS` (`0x82057c`) cleared | the same |

How to read them on a cold card: `tools/vfi_snap.py` (or `cmp-gen23read <bdf>` for the last one). A cold card with all
four cleared advertises 16 GT/s in config `LnkCap`; with `OPT_PCIE_BOOT_GEN23_DIS` still set it advertises 2.5 GT/s.

`OPT_PCIE_BOOT_GEN23_DIS` (fuse chain 2, block 49, bit 6) is the Gen4 gate. On a card with it still set, E1 write 7
halted the whole host. `cmp-e1steps` refuses such a card and the service skips it. If your card was burned without it,
it needs one more FF record in a new glitch session (block 49 `0x0064` to `0x0024`; the lab's record was `0x00240c42`,
the row depends on the card). Put it in the first burn plan instead.

## What the host needs

- **The driver:** the cmpunlocker driver for open-gpu-kernel-modules 615.71.09, with `driver/fb-geometry-80g.patch`
  if you want 80 GB (see `driver/README.md` for the tested base). Module options, as the lab runs them: cmpunlocker's
  `NVreg_RegistryDwords` line (in `/etc/modprobe.d/cmp-pcie-gen2.conf`) without its `RMPcieLinkSpeed=0x1`, and a
  per-device string that lists every burned card by its full PCI address:

  ```
  options nvidia NVreg_RegistryDwords="RmForceEnableGen2=1"
  options nvidia NVreg_RegistryDwordsPerDevice="pci=0000:05:00.0;RMPcieLinkSpeed=0x5;pci=0000:06:00.0;RMPcieLinkSpeed=0x5"
  ```

  Keep a single `NVreg_RegistryDwords` line in all of `/etc/modprobe.d` (the last one read wins), and note that
  cmpunlocker's `install.sh` rewrites that file on every run. `RMPcieLinkSpeed=0x5` is a bit mask that lets the driver
  train Gen3 when asked (it does not mean Gen5). Put it only on burned cards. After a reboot, `nvidia-smi --query-gpu=pci.bus_id,pcie.link.gen.max,pcie.link.gen.gpumax --format=csv`
  shows max 3 for those cards (gpumax 4 on a card that can do Gen4); unburned cards stay at 2.
- **The RM speed helper `cmp-pcie-speed`:** built from `tools/set_pcie_speed.c` of
  [cmp170hx-10gb-pcie-gen4](https://github.com/darkmaniac7/cmp170hx-10gb-pcie-gen4) against the same driver source:

  ```sh
  cc -std=gnu11 -O2 -Wall -Wextra -I<open-gpu-kernel-modules-615.71.09>/src/common/sdk/nvidia/inc \
     set_pcie_speed.c -o cmp-pcie-speed
  ```

- `pciutils` (`setpci`, `lspci`), `python3`, root.
- **A host you can power cycle** while you try it the first time. A crash during a step can halt the whole host (see
  [Traps](#traps)).

## Install

```sh
install -m 0755 cmp-pcie-speed /usr/local/sbin/
cd tools/pcie
install -m 0755 cmp-pcie-boot cmp-rmwalk cmp-e1steps cmp-gen4retrain cmp-gen23read cmp-gen-switch cmp-linkmon /usr/local/sbin/
install -m 0644 cmp-pcie-boot.service /etc/systemd/system/
# Add your miner or inference units to Before= in the unit first, so they start on the final link speed.
systemctl daemon-reload
systemctl enable cmp-pcie-boot.service
```

Try it by hand once before you enable it (next section), on one card, with nothing running on the cards.

## By hand, one card

```sh
B=05                                    # the card's bus number
cmp-gen23read 0000:$B:00.0              # 0 = Gen4 possible, 1 = stop at Gen3
cmp-rmwalk $B                           # Gen2 -> Gen3 through the driver, 60 s settle; log in /var/log/cmp-pcie/
cmp-e1steps 0000:$B:00.0                # only if GEN23 read 0: the seven E1 writes, one at a time
cmp-gen4retrain 0000:$B:00.0            # one retrain to Gen4, 60 s settle
lspci -s $B:00.0 -vv | grep -E 'LnkSta:|LnkSta2:'
```

| Script | Does | Exit codes |
|---|---|---|
| `cmp-rmwalk <bus>` | RM speed 1, check Gen1, RM speed 2, check Gen2, target link speed 3 at both ends, RM speed 3, settle (`SETTLE`, default 60 s) | 0 pass; 1 precondition not met, nothing changed; 2 card or port unreadable, needs a cold power cycle; 3 to 6 Gen3 not reached or not held, put back at Gen2 targets |
| `cmp-e1steps <bdf>` | the Gen4 PHY init (E1), seven read-modify-writes in BAR0, one at a time, with checks after each | 0 done; 1 refused (not `20c2`, GEN23 set, DSOV 0, compute process, not Gen3); 2 a register read back poisoned before a write; 3 link or Xid changed after a write; 4 root port unhealthy after write 7 |
| `cmp-gen4retrain <bdf>` | target link speed 4 at both ends, one Retrain Link on the root port, 60 s settle | 0 pass; 1 refused; 2 link lost; 5 Gen4 not established (targets parked at 3); 6 fell back during the settle |
| `cmp-gen23read <bdf>` | prints `OPT_PCIE_BOOT_GEN23_DIS` (0 or 1), read only | |
| `cmp-gen-switch <3\|4> <bus>...` | switches links that had E1 this boot between Gen3 and Gen4 by a config-space retrain only, for A/B tests without a reboot | 0 all switched; 3 to 5 stopped at a link |
| `cmp-linkmon` | read only: LnkSta and AER status of every `20c2` card and its port, one line a minute; a separate events log when a CE or UE bit is set | |
| `cmp-pcie-boot` | the boot service: stage 1 `cmp-rmwalk` on every `20c2` card; stage 2 `cmp-e1steps` then `cmp-gen4retrain` on every card whose GEN23 reads 0 and whose link is at Gen3 | always 0; results in the journal |

`cmp-gen4retrain` runs a bandwidth check after a pass if you set `CMP_PCIE_BW` to a command (it gets
`CUDA_VISIBLE_DEVICES` set to the card); any pinned-memory copy test works.

### The seven E1 writes

The A100 PHY init that CMPGlitch worked out for the 10 GB card, in this order (non-link registers first):

| # | Register | Change |
|---|---|---|
| 1 | `0x88610` VSEC hierarchy | `\|= 0x1001` |
| 2 | `0x8841C` PRIV_MISC_1 | set bits 11 and 13, clear 12, 14, 30 and 31 |
| 3 | `0x8C2C0` CYA_0 | clear bits 0, 2, 3, 13 and 23 |
| 4 | `0x88CE4` | low byte = `0x14` |
| 5 | `0x88CE0` | bits 5:0 = 6 |
| 6 | `0x8C1C0` PL_LINK_RATE | bits 19:16 = 4 |
| 7 | `0x8C040` LINK_CONFIG_0 | clear bits 19:18 |

Before write 7, Hardware Autonomous Speed Disable (`LnkCtl2` bit 5) is set on the card and the root port; after it the
script keeps 3 s with no BAR0 access, then reads the root port before the card. After write 7 the card's internal
`LnkCap` reads max speed 4; the link itself stays at Gen3 until `cmp-gen4retrain`.

## The boot service

```
cmp-pcie-boot[812]: card 05 Gen3 ok (Speed 8GT/s, Width x16)
cmp-pcie-boot[812]: card 06 Gen3 ok (Speed 8GT/s, Width x16)
cmp-pcie-boot[812]: card 07 Gen3 ok (Speed 8GT/s, Width x16)
cmp-pcie-boot[812]: card 05 Gen4: e1 rc 0, retrain rc 0, link 1104
cmp-pcie-boot[812]: card 06 Gen4 disabled, skipped
cmp-pcie-boot[812]: card 07 Gen4: e1 rc 0, retrain rc 0, link 1104
```

`link 1104` is `LnkSta`: speed 4 (16 GT/s), width x16. About 40 s per card for Gen3 and about 90 s more per card for
Gen4, so seven cards take about 12 minutes. Per-card logs: `/var/log/cmp-pcie/` (`rmwalk-*`, `boot-e1-<bus>.log`,
`boot-g4-<bus>.log`).

**The crash-loop guard.** Before each card's step the service writes a marker (`inflight-<bus>` for Gen3,
`inflight-g4-<bus>` for Gen4) in `/var/lib/cmp-pcie-boot` and syncs it; it removes the marker when the step returns. If
the host went down during a step, the marker is still there at the next boot: that card's step is disabled
(`disabled-<bus>` or `disabled-g4-<bus>`) and skipped from then on, and the rest of the cards go on as normal. A card
lost off the bus during the Gen3 walk or the Gen4 retrain (`rc 2`, or an unreadable `LnkSta`) also gets `disabled-<bus>`
or `disabled-g4-<bus>` and stops the service so the next cold boot skips the step that dropped it.

| To | Do |
|---|---|
| retry a disabled card | `rm /var/lib/cmp-pcie-boot/disabled-<bus>` (or `disabled-g4-<bus>`) |
| skip Gen4 on every card | `touch /var/lib/cmp-pcie-boot/off-g4` |
| skip everything | `touch /var/lib/cmp-pcie-boot/off` |

The markers are keyed by bus number, so they follow the slot, not the card. Cards are found by bus number in PCI domain 0.

## Traps

- **Never run the E1 writes on a card whose `OPT_PCIE_BOOT_GEN23_DIS` reads 1.** On such a card write 7 halted the host
  (a sync flood on the EPYC server; the BMC power cycled it). Writes 1 to 6 were harmless on it.
- **One aligned 32-bit store per register.** Python's `struct.pack_into` zeroes its destination before it packs, so a
  BAR0 write through it first stores `0x00000000`. On `LINK_CONFIG_0` that knocked the link out for a moment, and the
  EPYC server answered with a sync flood: that was the cause of the host halts the lab saw (5 of 15 runs before the
  fix). With single stores, HASD before write 7 and the quiet window there has been no halt on the same server: 12 of
  12 test runs, then every boot of the service since. The lab's Intel bench never halted, even with the old writes. Update any copy of an E1 script from before 22 November 2026.
- **Never unbind and rebind the driver at Gen4.** The probe failed with -5, BAR0 read `0xbadf1020`, and the driver
  logged Xid 140. Reboot for each new attempt.
- **One retrain per attempt.** If Gen4 does not come up, the scripts park the targets at 3 and stop. Another try needs a
  reboot.
- **Some slots are worse than others.** On the lab's server six slots hold Gen4 x16 cleanly once the writer was fixed,
  while one slot (shared fan shroud, correctable RxErr and replay timeouts even at Gen3) passes all seven E1 writes and
  then drops the card (`Xid 79`) when the root port retrains to 16 GT/s. Leave a card at Gen3 in such a slot (the guard
  disables Gen4 after a halt or a lost link; `touch` its `disabled-g4-<bus>` to do it by hand) or reseat/move it.
  `cmp-linkmon` shows slots that keep logging correctable errors.
- **Start the cards' users after the service.** The walk refuses a card with a compute process on it.
- **The 10 GB card (`10de:2082`)** has a different route (x4 link, driver patches, a software fuse override):
  [cmp170hx-10gb-pcie-gen4](https://github.com/darkmaniac7/cmp170hx-10gb-pcie-gen4). These scripts refuse it.

More: [PCIe Gen4 on a burned 8 GB card](https://cmp.wiki/wiki/PCIe_Gen4_on_a_burned_8_GB_card),
[PCIe Gen4 on the 10 GB card](https://cmp.wiki/wiki/PCIe_Gen4_on_the_10_GB_card) (the E1 table and pass gates),
[PCIe Gen3 on the 10 GB card](https://cmp.wiki/wiki/PCIe_Gen3_on_the_10_GB_card) (the RM walk).

Tests (no hardware): `python3 -I tests/test_pcie.py`.
