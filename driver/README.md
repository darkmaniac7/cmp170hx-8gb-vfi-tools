# 80 GB under the driver

A burned 8 GB card with the 80 GB layout (10 of its 12 FB partitions active) still shows 64 GiB under the mainstream
unlocker: cmpunlocker programs the same 64 GiB geometry on every 8 GB card (`FBPA_CFG1` `0x02779000`, `LMR` `0x20B`).
`fb-geometry-80g.patch` makes the driver choose per card, from what the card itself reports:

| The card reports | The driver gives it |
|---|---|
| exactly 10 of 12 FBPs active, consistent masks (below) | 80 GiB, `LMR` `0x28B` (`FBPA_CFG1` unchanged) |
| anything else: a stock card (8 active), a card burned for compute only, a card whose masks disagree | 64 GiB, the values the unlocker writes today |

On the lab's EPYC server, seven burned cards run on this logic at 81920 MiB each. Their FBP off masks are `0x840` (five
cards), `0x024` (card H) and `0x009` (card E): three layouts among seven cards. That is why the patch reads each card
instead of hard-coding a mask.

## What it checks

A card gets 80 GiB only when all of these hold; it reads registers only, and none at all on a card whose pre-unlock
FB size is not a 10-partition size:

- devinit sized the card for exactly 10 partitions (FB 10 GiB, `LMR` `0x288`, stock `FBPA_CFG1` `0x02449000`), or the
  80 GiB values of an earlier init are still in place;
- `OPT_FBP_DISABLE` has exactly 2 of its 12 bits set, `STATUS_FBP` agrees, and no FBP marked in `OPT_FBP_DEFECTIVE` is
  active;
- `OPT_FBPA_DISABLE`, `OPT_FBIO_DISABLE` and `OPT_ROP_L2_DISABLE` all equal the pair expansion of the FBP mask (FBP n
  owns bits 2n and 2n+1);
- `FBPA_NUM_ACTIVE` equals the active FBP count.

It falls back to 64 GiB by itself if the 80 GiB values do not read back after the write, and if GSP fails to boot at 80
GiB a retry uses 64 GiB. One log line per card says what it chose and why.

The registry key `CmpFbGeometry` (in `NVreg_RegistryDwords`): absent or 1 = automatic, 2 = log only (every card gets 64
GiB, the log says which would get 80), 0 = off (the kill switch).

## Status

- The geometry code in this patch is byte-identical to the code in the driver the lab's EPYC server runs. That driver is
  built on the Morrowmake fork of cmpunlocker (branch `p2p-ecc`, `87cb5fd`), where the patch applies with no offset.
- The recipe below uses mainstream cmpunlocker at `2c7e2ec`. There the patch applies with no fuzz (four hunks at offset
  -15 lines) and the module builds with no new warnings (kernel 6.8). A module built this way has not been loaded on a
  card by the lab yet. Reports welcome.
- It also applies (not built) to the 615.71.10 and 615.78.08 sources with the same cmpunlocker commit.

## Build

You need the kernel headers for the running kernel, gcc, `patch` and a working cmpunlocker install on 615.71.09 with the
8gb profile (the firmware, the module directory and cmpunlocker's modprobe file come from it).

```sh
git clone https://github.com/amoghmunikote/cmpunlocker.git
git -C cmpunlocker checkout 2c7e2ecd7944e791fec040d2680036beb4a9327b
git clone https://github.com/darkmaniac7/cmp170hx-8gb-vfi-tools.git
curl -L -o ogkm-615.71.09.tar.gz \
  https://github.com/NVIDIA/open-gpu-kernel-modules/archive/refs/tags/615.71.09.tar.gz
echo "caf48cda7d5fe7374d1d24ca4a90efb4dc783eefabfad5fa4b64fdc24213b62a  ogkm-615.71.09.tar.gz" | sha256sum -c
tar -xzf ogkm-615.71.09.tar.gz
cd open-gpu-kernel-modules-615.71.09

C=../cmpunlocker/driver/patches
for p in sec2-postbl-plm-ss-cfg booter-verify late-pma bar0-pramin-clamp ce-scrub-workarounds \
         persistent-sw-state pcie-gen2 pcie-gen2-probe-retrain name-string bar1-resize-unlock \
         cmp-sku-mask ecc-enable ecc-fbpa-static ecc-reporting; do
  patch -p1 --forward < "$C/$p.patch" || { echo "FAILED: $p"; break; }
done
patch -p1 < ../cmp170hx-8gb-vfi-tools/driver/fb-geometry-80g.patch

make -j"$(nproc)" modules SYSSRC=/lib/modules/$(uname -r)/build CC=gcc
```

That is cmpunlocker's own patch order at that commit, with the geometry patch last. `pcie-gen2.patch` reports "hunk 1
succeeded with fuzz 1": that is cmpunlocker's own and happens without this patch too.

The patch needs cmpunlocker's `sec2-postbl-plm-ss-cfg.patch` (it uses that patch's device IDs, its `CFG1`/`LMR` write
and its FB size override). It does not apply to a stock NVIDIA tree.

## Install

As root, with no GPU clients running. Back up the current modules first.

```sh
KVER=$(uname -r)
MODDIR=/lib/modules/$KVER/updates/cmpunlocker
mkdir -p /var/backups/cmp-fb-geometry
cp -a "$MODDIR"/nvidia*.ko /var/backups/cmp-fb-geometry/
install -m 0644 kernel-open/nvidia*.ko "$MODDIR"/
depmod -a "$KVER"
update-initramfs -u -k "$KVER"
```

Only `nvidia.ko` changes in content. For the first boot, ask for log only: cmpunlocker's installer writes
`/etc/modprobe.d/cmp-pcie-gen2.conf` with one `NVreg_RegistryDwords` string; add `;CmpFbGeometry=2` inside it (keep a
single `NVreg_RegistryDwords` line in all of `/etc/modprobe.d`; the last one read wins). Cold boot, then:

```sh
dmesg | grep 'FB geometry'
```

```
SEC2_DEBUG: FB geometry 0000:05:00: probe preFb=0x280000000 LMR=0x00000288 CFG1=0x02449000 FBP=0x00000840 ...
SEC2_DEBUG: FB geometry 0000:05:00: legacy 64 GiB, dry run; this card qualifies for 80 GiB (LMR 0x0000028b)
SEC2_DEBUG: FB geometry 0000:06:00: legacy 64 GiB, pre-unlock FB 0x200000000 is not a 10-partition size
```

If the cards you expect qualify, take `;CmpFbGeometry=2` out (automatic) and cold boot again:

```
SEC2_DEBUG: FB geometry 0000:05:00: 10 of 12 FBP active (off mask 0x840) -> 80 GiB, LMR 0x0000028b
```

`nvidia-smi --query-gpu=pci.bus_id,memory.total --format=csv` then shows 81920 MiB on those cards. cmpunlocker's
`verify.sh` accepts it (its pass line for an 8 GB card is 60000 MiB or more).

**Test the whole framebuffer before you trust it**, with a pattern test that writes and reads back all of it, then a
real load. Not every burned card has 80 GiB that works: one of ten cards in the GA100VFI write-up had only 64 GiB
usable. See [Memory errors and ECC](https://cmp.wiki/wiki/Memory_errors_and_ECC) and
[8 GB compute and HBM](https://cmp.wiki/wiki/8_GB_compute_and_HBM:_limits_and_open_questions).

**Undo:** `CmpFbGeometry=0` in the registry string (every card back to 64 GiB), or copy the backed-up modules back,
`depmod`, `update-initramfs` and reboot.

### Keeping it across cmpunlocker reinstalls

cmpunlocker's `install.sh` rebuilds the modules and rewrites `cmp-pcie-gen2.conf` on every run, so a reinstall drops the
patch and the registry key. To have `install.sh` build it in, copy the patch to `cmpunlocker/driver/patches/` and
declare it in two places (without the second, `build.sh` stops with "patch fb-geometry-80g.patch is built but not
declared in constants.yaml"):

```diff
--- a/common/constants.yaml
+++ b/common/constants.yaml
@@ -142,3 +142,7 @@ unlocks:
   ecc-reporting:
     patch: ecc-reporting.patch
     registers: {}
+
+  fb-geometry-80g:
+    patch: fb-geometry-80g.patch
+    registers: {}
--- a/driver/build.sh
+++ b/driver/build.sh
@@ -60,6 +60,7 @@ PATCH_ORDER=(
     ecc-enable.patch
     ecc-fbpa-static.patch
     ecc-reporting.patch
+    fb-geometry-80g.patch
 )
```

Absent registry key means automatic, so the patch works after a reinstall without the key.

## With PCIe Gen3 and Gen4

The lab's server runs this driver with these module options for its burned cards (one `pci=` entry per burned card):

```
options nvidia NVreg_RegistryDwords="RmForceEnableGen2=1"
options nvidia NVreg_RegistryDwordsPerDevice="pci=0000:05:00.0;RMPcieLinkSpeed=0x5;pci=0000:06:00.0;RMPcieLinkSpeed=0x5"
```

that is, cmpunlocker's `NVreg_RegistryDwords` line without its `RMPcieLinkSpeed=0x1`, and `RMPcieLinkSpeed=0x5` per
burned card. The boot service that takes them to Gen3 and Gen4 is in [`../tools/pcie/`](../tools/pcie/README.md).

## License

This patch is GPL v2, like the cmpunlocker patches it builds on (`LICENSE` in this folder). The files it modifies keep
their NVIDIA license notices. The rest of this repository is MIT.
