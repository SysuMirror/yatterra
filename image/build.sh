#!/bin/bash
# Build sse/cloud-ubuntu:24.04 without docker hub: debootstrap rootfs -> docker import
set -e
ROOTFS=/tmp/cloud-rootfs
MIRROR=http://archive.ubuntu.com/ubuntu
IMG=sse/cloud-ubuntu:24.04

echo "==> debootstrap noble"
sudo rm -rf "$ROOTFS"
sudo debootstrap --variant=minbase --include=apt,apt-utils,ca-certificates,gnupg,locales noble "$ROOTFS" "$MIRROR"

echo "==> configure apt sources inside rootfs"
sudo tee "$ROOTFS/etc/apt/sources.list.d/ubuntu.sources" >/dev/null <<'SRC'
Types: deb
URIs: http://archive.ubuntu.com/ubuntu/
Suites: noble noble-updates noble-backports
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: noble-security
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
SRC

echo "==> chroot install packages"
sudo chroot "$ROOTFS" /bin/bash -ex <<'INSTALL'
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  openssh-server sudo build-essential python3 python3-pip python3-venv \
  nodejs npm git curl wget vim tmux htop man-db locales tini iproute2 less
locale-gen en_US.UTF-8
rm -rf /var/lib/apt/lists/*
INSTALL

echo "==> install cgroup-aware free(1)"
sudo tee "$ROOTFS/usr/local/bin/free" >/dev/null <<'FREE'
#!/usr/bin/env python3
"""Show container memory limits instead of node-wide /proc/meminfo totals."""
import os
import sys

def read_int(path):
    try:
        value = open(path).read().strip()
        return None if value == "max" else int(value)
    except (OSError, ValueError):
        return None

def limit_and_usage():
    for lim, use in (("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.current"),
                     ("/sys/fs/cgroup/memory/memory.limit_in_bytes",
                      "/sys/fs/cgroup/memory/memory.usage_in_bytes")):
        total, used = read_int(lim), read_int(use)
        if total is not None and used is not None and total < (1 << 60):
            return total, min(total, used)
    return None

def meminfo():
    out = {}
    try:
        for line in open("/proc/meminfo"):
            key, value = line.split(":", 1)
            out[key] = int(value.split()[0]) * 1024
    except (OSError, ValueError):
        pass
    return out

def human(value):
    units = ("B", "Ki", "Mi", "Gi", "Ti", "Pi")
    n, unit = float(value), 0
    while n >= 1024 and unit < len(units) - 1:
        n, unit = n / 1024, unit + 1
    return f"{n:.1f}{units[unit]}"

def formatted(value, mode):
    if mode == "b": return str(value)
    if mode == "k": return str(value // 1024)
    if mode == "m": return str(value // (1024 * 1024))
    if mode == "g": return str(value // (1024 * 1024 * 1024))
    return human(value)

def main():
    # Preserve the normal procps behavior when no cgroup limit is present.
    constrained = limit_and_usage()
    if constrained is None:
        os.execv("/usr/bin/free", ["/usr/bin/free", *sys.argv[1:]])
    mode = "h"
    for arg in sys.argv[1:]:
        if arg in ("-b", "--bytes"): mode = "b"
        elif arg in ("-k", "--kibi"): mode = "k"
        elif arg in ("-m", "--mebi"): mode = "m"
        elif arg in ("-g", "--gibi"): mode = "g"
        elif arg in ("-h", "--human"): mode = "h"
    total, used = constrained
    available = max(0, total - used)
    info = meminfo()
    swap_total = info.get("SwapTotal", 0)
    swap_free = info.get("SwapFree", 0)
    print("               total        used        free      shared  buff/cache   available")
    print("Mem:", *(f"{formatted(v, mode):>10}" for v in (total, used, available, 0, 0, available)))
    print("Swap:", *(f"{formatted(v, mode):>10}" for v in
                       (swap_total, swap_total - swap_free, swap_free)))

if __name__ == "__main__":
    main()
FREE
sudo chmod 0755 "$ROOTFS/usr/local/bin/free"

echo "==> user + sshd config"
sudo chroot "$ROOTFS" /bin/bash -ex <<'SETUP'
# uid/gid 1000 — must match siteconf.CLOUD_UID (default 1000) and the hostPath
# chown in web/groups.py, or cloud cannot write its persistent /home/cloud.
useradd -m -u 1000 -s /bin/bash -G sudo cloud
echo 'cloud ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/cloud
chmod 0440 /etc/sudoers.d/cloud
mkdir -p /run/sshd
ssh-keygen -A
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?AllowTcpForwarding.*/AllowTcpForwarding yes/' /etc/ssh/sshd_config
sed -i 's/^#\?X11Forwarding.*/X11Forwarding yes/' /etc/ssh/sshd_config
SETUP

echo "==> entrypoint"
sudo tee "$ROOTFS/entrypoint.sh" >/dev/null <<'ENT'
#!/bin/bash
set -e
mkdir -p /run/sshd
PW="${CLOUD_PASSWORD:-}"
if [ -n "$PW" ]; then
  echo "cloud:${PW}" | chpasswd
fi
exec /usr/sbin/sshd -D -e
ENT
sudo chmod +x "$ROOTFS/entrypoint.sh"

echo "==> import into docker"
sudo tar -C "$ROOTFS" -c . | sudo docker import - "$IMG"
sudo docker images "$IMG"

echo "==> import into k3s containerd"
sudo docker save "$IMG" | sudo k3s ctr images import -
sudo k3s crictl images | grep cloud-ubuntu
echo "DONE"
