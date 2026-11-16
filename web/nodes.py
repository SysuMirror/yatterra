"""Node registry — the single place that knows the cluster has >1 node.

Every group record may carry ``g["node"]``:
  * missing / ``"auto"`` → no placement fields at all (scheduler decides;
    with the spark taint that means wz8). Existing groups are untouched.
  * ``"wz8"`` / ``"spark"`` → the manifest gets a nodeSelector + toleration.

Profiles below describe per-node facts that the manifest generator needs:
GPU inventory, whether the host runs an MPS daemon, whether a host CUDA
toolkit exists to mount, and how to run commands on that node (locally or
via remote_hosts). Overridable via YATTERRA_NODES_JSON for other sites.
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
    },
    "spark": {
        "arch": "arm64",
        "gpu_ids": [0],
        "mps": False,
        "unified_memory": True,    # GB10 / DGX Spark: system RAM == VRAM (one pool)
        "cuda_host": None,         # GB10: no separate host CUDA mount wired yet
        "ssh_host": "spark",       # remote_hosts.json entry (LAN via relay)
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
    },
    "egress": {
        "arch": "amd64",
        "gpu_ids": [],
        "mps": False,
        "cuda_host": None,
        "ssh_host": "egress",
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
