"""Node registry — the single place that knows the cluster has >1 node.

Every group record may carry ``g["node"]``:
  * missing / ``"auto"`` → no placement fields at all (scheduler decides;
    with the spark taint that means wz8). Existing groups are untouched.
  * ``"wz8"`` / ``"spark"`` → the manifest gets a nodeSelector + toleration.

Profiles below describe per-node facts that the manifest generator needs:
GPU inventory, whether the host runs an MPS daemon, whether a host CUDA
toolkit exists to mount, and how to run commands on that node (locally or
via remote_hosts). Overridable via YATTERRA_NODES_JSON for other sites.

Sampling is not a per-node list. Driver version, per-pod VRAM, network
rates and disk IO rates are collected by fleet_probe.collect for every
host fleet_monitor inventories. A new machine is a profile here (arch,
ssh_host, disk_mounts) plus a remote_hosts.json entry of the same name.
Do not add a collector branch for that machine.
"""
import json
import os

import siteconf

DEFAULT_NODE = os.environ.get("YATTERRA_DEFAULT_NODE", "wz8")

# key = value of g["node"]; "ssh_host" = remote_hosts.json name (None = local).
_PROFILES = {
    "wz8": {
        "arch": "amd64",
        "gpu_ids": [0, 1, 2],
        "mps": True,
        "cuda_host": "/usr/local/cuda",
        "ssh_host": None,          # platform runs on this node
        # SSD root plus the HDD. Live sampling still follows YATTERRA_DISK_MOUNTS.
        "disk_mounts": ["/", "/mnt/sdb"],
    },
    "spark": {
        "arch": "arm64",
        "gpu_ids": [0],
        "mps": False,
        "unified_memory": True,    # GB10 / DGX Spark: system RAM == VRAM (one pool)
        "cuda_host": None,         # GB10: no separate host CUDA mount wired yet
        "ssh_host": "spark",       # remote_hosts.json entry (LAN via relay)
        "disk_mounts": ["/"],      # NVMe only; do not copy wz8's /mnt/sdb
    },
    # Placement ALIAS, not a machine: "昇腾 NPU" groups are ordinary CPU dev
    # boxes that live on the amd64 platform node (the Ascend cards are on a box
    # outside k3s and are reached over ssh from inside the pod, not scheduled by
    # k8s). "k8s_node" = the real node the nodeSelector targets, so the picker
    # and the groups.json record can read "npu" while the pod still schedules.
    "npu": {
        "arch": "amd64",
        "gpu_ids": [],             # no k8s GPUs on this placement
        "mps": False,
        "cuda_host": None,
        "ssh_host": None,          # commands run on the platform node (local)
        "k8s_node": "wz8",
    },
    # Joined as tainted agents. Empty gpu_ids: inventory is not probed here,
    # so placement must not claim devices that were not registered.
    "xfusion": {
        "arch": "amd64",
        "gpu_ids": [],
        "mps": False,
        "cuda_host": None,
        "ssh_host": "xfusion",
        "disk_mounts": ["/"],
    },
    "egress": {
        "arch": "amd64",
        "gpu_ids": [],
        "mps": False,
        "cuda_host": None,
        "ssh_host": "egress",
        "disk_mounts": ["/"],
    },
}


def _load():
    profiles = {k: dict(v) for k, v in _PROFILES.items()}
    raw = os.environ.get("YATTERRA_NODES_JSON", "")
    if raw:
        try:
            profiles.update(json.loads(raw))
        except (ValueError, TypeError):
            pass
    return profiles


def names():
    """Selectable node names (for the create/edit picker)."""
    return sorted(_load().keys())


def valid(node):
    return node in _load()


def profile(node):
    """Profile for a node name; unknown/empty falls back to the default node."""
    profiles = _load()
    return profiles.get(node) or profiles.get(DEFAULT_NODE) or {}


def hardware_hint(name, host_id=''):
    """Registry arch for a fleet host. Never invents GPU readings."""
    profiles = _load()
    local_names = {DEFAULT_NODE, 'local', os.environ.get('YATTERRA_LOCAL_HOST_NAME', 'gpu4090')}
    chosen = None
    key = None
    if name in profiles and not profiles[name].get('k8s_node'):
        chosen, key = profiles[name], name
    else:
        for profile_key, prof in profiles.items():
            if prof.get('k8s_node'):
                continue
            if name and name == prof.get('ssh_host'):
                chosen, key = prof, profile_key
                break
        if chosen is None and (host_id == 'local' or name in local_names):
            chosen, key = profiles.get(DEFAULT_NODE), DEFAULT_NODE
    if not chosen:
        return {}
    return {
        'profile': key,
        'arch': chosen.get('arch'),
        'unified_memory': bool(chosen.get('unified_memory')),
    }


def node_for(g):
    """Placement target for a group record. None = emit no placement fields."""
    node = (g or {}).get("node") or ""
    if not node or node == "auto":
        return None
    return node if valid(node) else None


def k8s_node(node):
    """The real cluster node a placement resolves to.

    Alias profiles (e.g. "npu") name a *logical* bucket, not a machine; their
    "k8s_node" says which node the selector must actually target. Everything
    that talks to the node (placement, run_on) goes through here."""
    return profile(node).get("k8s_node") or node


def is_local(node):
    """True when commands for this placement run on the platform node itself."""
    if node in (None, "", "auto", DEFAULT_NODE):
        return True
    return k8s_node(node) == DEFAULT_NODE


def placement_yaml(node):
    """nodeSelector + toleration block for the Deployment pod template.
    Empty string when no explicit placement — byte-identical manifests
    for existing (auto) groups."""
    if not node:
        return ""
    target = k8s_node(node)
    return (
        "      nodeSelector:\n"
        f"        yatterra/node: {target}\n"
        "      tolerations:\n"
        "      - key: yatterra/dedicated\n"
        "        operator: Equal\n"
        f"        value: {target}\n"
        "        effect: NoSchedule\n"
    )


def gpu_ids(node, assigned=None):
    """GPU indices visible on a node: assigned ∩ node inventory, else all."""
    prof = profile(node)
    # An explicitly empty inventory (CPU-only alias like "npu") stays empty;
    # only profiles that say nothing about GPUs fall back to the single-GPU
    # default this registry started with.
    ids = list(prof["gpu_ids"]) if "gpu_ids" in prof else [0]
    if assigned:
        want = [i for i in assigned if i in ids]
        if want:
            return want
    return ids


def visible_devices(node, assigned=None):
    ids = gpu_ids(node, assigned)
    # GB10/spark: legacy NVIDIA_VISIBLE_DEVICES=0 injection on k3s gets its
    # device-cgroup (eBPF) rules clobbered by kubelet ~seconds after container
    # start -- running CUDA then dies with cudaErrorNotPermitted and wedges the
    # whole node (all contexts must be released to recover).  The CDI device
    # name lands in the OCI spec, so the rules survive.  Docker on the host is
    # unaffected; WZ8 keeps the legacy form.
    if unified_memory(node):
        return "nvidia.com/gpu=all"
    return ",".join(map(str, ids))


def has_mps(node):
    return bool(profile(node).get("mps"))


def unified_memory(node):
    """True when the node's system RAM and GPU VRAM are a single pool (GB10).
    The scheduler then sizes VRAM needs from the node's ``free -m`` instead of
    nvidia-smi (which reports '[N/A]' memory on such nodes)."""
    return bool(profile(node).get("unified_memory"))


def cuda_host(node):
    return profile(node).get("cuda_host") or ""


def disk_mounts(name):
    """Mounts configured for this machine, or None when the name is unknown.

    Looks up the profile key, then ``ssh_host``. Unknown names do not fall
    back to wz8, so a one-disk host never inherits ``/mnt/sdb``. ``npu`` is
    an alias, not a machine, and has no disk list here. The sampler still
    runs the shared probe for whatever mounts this returns.
    """
    profiles = _load()
    prof = profiles.get(name)
    if not isinstance(prof, dict):
        prof = None
        for candidate in profiles.values():
            if not isinstance(candidate, dict) or candidate.get("k8s_node"):
                continue
            if name and candidate.get("ssh_host") == name:
                prof = candidate
                break
    prof = prof or {}
    mounts = prof.get("disk_mounts")
    if isinstance(mounts, list) and mounts and all(isinstance(m, str) for m in mounts):
        return list(mounts)
    return None


def shares_group_storage(src, dst):
    """True when both nodes already see one group disk.

    Same machine is shared. Otherwise the UUID of ``GROUP_DATA_ROOT`` must
    match, or both mounts must be the same NFS source. A missing directory
    is not shared — the caller copies.
    """
    if is_local(src) and is_local(dst):
        return True
    return _mount_signature(src) != "" and _mount_signature(src) == _mount_signature(dst)


def _mount_signature(node):
    root = siteconf.GROUP_DATA_ROOT.rstrip("/")
    parent = os.path.dirname(root)
    cmd = (
        f"test -d {parent}/shared && test -d {parent}/interop && "
        f"findmnt -n -P -o UUID,FSTYPE,SOURCE --target {root}"
    )
    ok, out = run_on(node, cmd, timeout=20)
    if not ok:
        return ""
    line = ""
    for row in out.splitlines():
        if "UUID=" in row or "FSTYPE=" in row or "SOURCE=" in row:
            line = row.strip()
    if not line:
        return ""
    fields = {}
    for part in line.split():
        if "=" in part:
            key, value = part.split("=", 1)
            fields[key] = value.strip('"')
    uuid = fields.get("UUID") or ""
    fstype = fields.get("FSTYPE") or ""
    source = fields.get("SOURCE") or ""
    if uuid:
        return "uuid:" + uuid
    if fstype.startswith("nfs") and source:
        return "nfs:" + source
    return ""


def pipe_root(src, dst, src_command, dst_command, timeout=1800):
    """Pipe a root command on ``src`` into a root command on ``dst``.

    ``None`` and the platform node are local. Other names use their
    ``ssh_host``. Returns (ok, error tail). The byte stream is not kept.
    """
    import remote_hosts
    src_host = None if is_local(src) else (profile(src).get("ssh_host") or src)
    dst_host = None if is_local(dst) else (profile(dst).get("ssh_host") or dst)
    return remote_hosts.pipe_root(src_host, src_command, dst_host, dst_command, timeout=timeout)


def run_on(node, command, timeout=30):
    """Run a shell command on the given node. Returns (ok, output).

    The default node runs locally (the platform lives there); other nodes
    go through their remote_hosts.json entry. Never raises.
    """
    if is_local(node):
        import subprocess
        try:
            r = subprocess.run(["bash", "-c", command], capture_output=True,
                               text=True, timeout=timeout)
            out = (r.stdout or "") + (r.stderr or "")
            return r.returncode == 0, out
        except Exception as e:
            return False, str(e)
    import remote_hosts
    return remote_hosts.run_remote(profile(node).get("ssh_host") or node,
                                   command, sudo=True, timeout=timeout)


def ensure_home(node, name):
    """Pre-create the group home dir on the target node with cloud ownership.

    Mirrors the local branch of create_group: kubelet's DirectoryOrCreate
    would make it root-only, so the dir must exist chowned to CLOUD_UID
    before the pod mounts it.
    """
    path = f"{siteconf.GROUP_DATA_ROOT}/{name}/home"
    uid = siteconf.CLOUD_UID
    cmd = f"mkdir -p {path} && chown {uid}:{uid} {path} && chmod 750 {path}"
    return run_on(node, cmd)
