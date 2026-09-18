#!/bin/bash
set -e
mkdir -p /run/sshd
# Set the cloud user's password from the environment (injected per group
# by the platform as CLOUD_PASSWORD).
PW="${CLOUD_PASSWORD:-}"
if [ -n "$PW" ]; then
  echo "cloud:${PW}" | chpasswd
fi
# cloud already has NOPASSWD sudo (see build.sh), so no prompt on apt/pip.
exec /usr/sbin/sshd -D -e
