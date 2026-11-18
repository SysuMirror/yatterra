#!/bin/sh
# Plan a new node. --check prints the plan and does not join, SSH, or write files.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
exec python3 "$ROOT/node_install.py" "$@"
