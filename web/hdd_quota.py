#!/usr/bin/env python3
"""Hard size cap for the per-group HDD directory mounted at /data.

`/home/cloud` is an existing directory tree on the HDD (not the SSD). The
14T filesystem cannot enable project quotas while it is mounted, so the cap
is a fixed-size ext4 image. Writes past that size fail with ENOSPC. The
image lives next to the home directory and is loop-mounted at
`<GROUP_DATA_ROOT>/<name>/data` before the pod starts.
"""
import os
import subprocess

import siteconf

DATA_MOUNT = "/data"


def storage_bytes(storage):
    """Parse a Kubernetes-style quantity into bytes. Bare numbers are GiB."""
    s = str(storage).strip()
    if not s:
        raise ValueError("empty storage")
    units = (("Ti", 1024 ** 4), ("Gi", 1024 ** 3), ("Mi", 1024 ** 2),
             ("Ki", 1024), ("T", 1000 ** 4), ("G", 1000 ** 3),
             ("M", 1000 ** 2), ("K", 1000))
    for suf, mul in units:
        if s.endswith(suf):
            return int(float(s[:-len(suf)]) * mul)
    return int(float(s) * (1024 ** 3))


def paths(name):
    root = siteconf.GROUP_DATA_ROOT.rstrip("/")
    base = f"{root}/{name}"
    return f"{base}/data.img", f"{base}/data"


def ensure_script(name, storage):
    """Shell that creates and mounts the image. Idempotent. Runs as root."""
    nbytes = storage_bytes(storage)
    if nbytes < 1024 ** 3:
        raise ValueError("HDD data volume must be at least 1Gi")
    img, mnt = paths(name)
    uid = siteconf.CLOUD_UID
    # The fstab line is matched exactly so a second ensure does not duplicate it.
    line = f"{img} {mnt} ext4 loop,nofail 0 0"
    return f"""set -euo pipefail
img={img}
mnt={mnt}
mkdir -p "$(dirname "$img")"
if [ ! -e "$img" ]; then
  fallocate -l {nbytes} "$img"
  mkfs.ext4 -F -q -m 0 -E lazy_itable_init=1,lazy_journal_init=1 "$img"
fi
mkdir -p "$mnt"
if ! findmnt -n "$mnt" >/dev/null 2>&1; then
  mount -o loop "$img" "$mnt"
fi
chown {uid}:{uid} "$mnt"
chmod 750 "$mnt"
grep -qxF {subprocess.list2cmdline([line])} /etc/fstab || printf '%s\\n' {subprocess.list2cmdline([line])} >> /etc/fstab
"""


def rename_tree_script(old, new, storage):
    """Move one group's directory on the node that already holds it.

    Unmounts the loop image first so ``mv`` takes the file, not the mount.
    Mounts it again only when ``data.img`` came along. ``/etc/fstab`` is
    rewritten only when it already mentions that image.

    Release uses a *lazy* unmount fallback: a running pod (or a kubelet mount
    namespace that still references the path) keeps the loop mount "busy", so a
    plain ``umount`` fails and — under ``set -e`` — aborts the whole rename.
    ``umount -l`` detaches the mount from the namespace, which is all ``mv``
    needs; the backing device is freed once the last reference drops.
    """
    root = siteconf.GROUP_DATA_ROOT.rstrip("/")
    old_img, old_mnt = paths(old)
    mount_new = ensure_script(new, storage)
    return f"""set -euo pipefail
old={root}/{old}
new={root}/{new}
if [ ! -d "$old" ]; then
  echo "missing $old" >&2
  exit 1
fi
if [ -e "$new" ]; then
  echo "exists $new" >&2
  exit 1
fi
if findmnt -n {old_mnt} >/dev/null 2>&1; then
  umount {old_mnt} 2>/dev/null || umount -l {old_mnt} 2>/dev/null || umount -f {old_mnt} 2>/dev/null || true
fi
if [ -f {old_img} ] && grep -qF {old_img} /etc/fstab; then
  grep -vF {old_img} /etc/fstab > /etc/fstab.yatterra-rename
  mv /etc/fstab.yatterra-rename /etc/fstab
fi
mv "$old" "$new"
if [ -f "$new/data.img" ]; then
{mount_new}
fi
"""


def unmount_script(name):
    """Unmount the group's /data image so a later tar copies the file.

    Falls back to a lazy unmount when the mount is held by a pod / kubelet
    namespace (otherwise a plain ``umount`` aborts under ``set -e``).
    """
    img, mnt = paths(name)
    return f"""set -euo pipefail
if findmnt -n {mnt} >/dev/null 2>&1; then
  umount {mnt} 2>/dev/null || umount -l {mnt} 2>/dev/null || umount -f {mnt} 2>/dev/null || true
fi
if [ -f {img} ] && grep -qF {img} /etc/fstab; then
  grep -vF {img} /etc/fstab > /etc/fstab.yatterra-rename
  mv /etc/fstab.yatterra-rename /etc/fstab
fi
"""


def erase_script(name):
    """Unmount the loop image, drop its fstab line, and remove the group tree.

    A mounted image must be unmounted first. ``rm`` of a live mount deletes
    the files inside the image and then leaves the mount point behind.
    Lazy unmount is tried when a pod / kubelet namespace still holds the mount,
    so deletion no longer leaves ``target is busy`` residue behind.
    """
    import shlex
    img, mnt = paths(name)
    root = os.path.dirname(img)
    qimg, qmnt, qroot = (shlex.quote(p) for p in (img, mnt, root))
    return f"""set -u
if findmnt -n {qmnt} >/dev/null 2>&1; then
  umount {qmnt} 2>/dev/null || umount -l {qmnt} 2>/dev/null || umount -f {qmnt} 2>/dev/null || exit 1
fi
if [ -f {qimg} ] && grep -qF {qimg} /etc/fstab; then
  grep -vF {qimg} /etc/fstab > /etc/fstab.yatterra-rename
  mv /etc/fstab.yatterra-rename /etc/fstab
fi
rm -rf {qroot}
if [ -e {qroot} ] || findmnt -n {qmnt} >/dev/null 2>&1; then
  echo "残留 {root}" >&2
  exit 1
fi
"""


def ensure(name, storage, node=None):
    """Create the capped image on the group's node. Returns (ok, output)."""
    import nodes
    script = ensure_script(name, storage)
    if nodes.is_local(node):
        try:
            r = subprocess.run(["bash", "-c", script], capture_output=True,
                               text=True, timeout=900)
        except Exception as e:
            return False, str(e)
        out = (r.stdout or "") + (r.stderr or "")
        return r.returncode == 0, out
    return nodes.run_on(node, script, timeout=900)
