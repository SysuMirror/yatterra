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

echo "==> user + sshd config"
sudo chroot "$ROOTFS" /bin/bash -ex <<'SETUP'
useradd -m -s /bin/bash -G sudo cloud
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
PW="${CLOUD_PASSWORD:-${STUDENT_PASSWORD:-}}"
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
