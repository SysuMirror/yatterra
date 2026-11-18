"""Plan a new fleet node. Check mode prints the plan and changes nothing.

Three architectures: cpu, gpu (discrete accelerator), and unified memory.
Disk mounts come only from the spec. Sampling stays on fleet_probe.collect
for every host; this module does not add a collector named after the node.
"""
import argparse
import json
import re
import sys

KINDS = {
    'cpu': 'cpu',
    'gpu': 'gpu',
    'unified': 'unified',
    'unified-memory': 'unified',
    'unified_memory': 'unified',
}

_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,62}')
_SSH = re.compile(r'[A-Za-z0-9][A-Za-z0-9.:%_-]*')
_USER = re.compile(r'[A-Za-z_][A-Za-z0-9_.-]*')
_ARCH = {'amd64': 'amd64', 'x86_64': 'amd64', 'arm64': 'arm64', 'aarch64': 'arm64'}


class PlanError(ValueError):
    """The operator spec cannot be turned into a node plan."""


def normalize_kind(kind):
    key = str(kind or '').strip().lower().replace(' ', '-')
    if key not in KINDS:
        raise PlanError('kind must be cpu, gpu, or unified-memory')
    return KINDS[key]


def _check_name(name):
    if not isinstance(name, str) or not _NAME.fullmatch(name) or name == 'local' or '/' in name:
        raise PlanError('invalid node name')
    return name


def _check_ssh(target):
    if not isinstance(target, str) or not _SSH.fullmatch(target):
        raise PlanError('invalid ssh target')
    return target


def _check_mounts(mounts):
    if not isinstance(mounts, (list, tuple)) or not mounts or len(mounts) > 32:
        raise PlanError('invalid disk mounts')
    seen = []
    for mount in mounts:
        if not isinstance(mount, str) or not mount.startswith('/') or '\x00' in mount or mount in seen:
            raise PlanError('invalid disk mounts')
        seen.append(mount)
    return seen


def _check_arch(kind, arch):
    if arch is None or arch == '':
        return 'arm64' if kind == 'unified' else 'amd64'
    key = str(arch).strip().lower()
    if key not in _ARCH:
        raise PlanError('arch must be amd64 or arm64')
    return _ARCH[key]


def registry_profile(plan):
    """Profile object the node registry and the sampler already understand."""
    profile = plan['profile']
    return {
        'arch': profile['arch'],
        'gpu_ids': [],
        'mps': False,
        'cuda_host': None,
        'ssh_host': plan['name'],
        'disk_mounts': list(profile['disk_mounts']),
        'unified_memory': bool(profile['unified_memory']),
    }


def plan_node(name, kind, mounts, ssh_target, arch=None, user='sse', port=22):
    """Return the registration plan for one new node. Does not touch the cluster."""
    name = _check_name(name)
    kind = normalize_kind(kind)
    mounts = _check_mounts(mounts)
    ssh_target = _check_ssh(ssh_target)
    arch = _check_arch(kind, arch)
    if not isinstance(user, str) or not _USER.fullmatch(user):
        raise PlanError('invalid ssh user')
    try:
        port = int(port)
    except (TypeError, ValueError):
        raise PlanError('invalid ssh port')
    if not 1 <= port <= 65535:
        raise PlanError('invalid ssh port')
    unified = kind == 'unified'
    discrete = kind == 'gpu'
    profile = {
        'arch': arch,
        'gpu_ids': [],
        'mps': False,
        'cuda_host': None,
        'ssh_host': name,
        'disk_mounts': list(mounts),
        'unified_memory': unified,
        'accelerator': 'discrete' if discrete else ('unified' if unified else 'none'),
        'advertise_nvidia_gpu': discrete,
        'discrete_vram_bytes': None,
    }
    steps = _steps(name, kind, mounts)
    return {
        'name': name,
        'kind': kind,
        'ssh_target': ssh_target,
        'user': user,
        'port': port,
        'profile': profile,
        'remote_host': {
            'name': name,
            'host': ssh_target,
            'user': user,
            'port': port,
        },
        'registration': {
            'profile_key': name,
            'ssh_host': name,
            'remote_hosts_name': name,
            'probe': 'fleet_probe.collect',
            'collector': 'fleet_monitor.collect_host',
            'per_host_collector': None,
        },
        'steps': steps,
    }


def _steps(name, kind, mounts):
    mounts_text = ' '.join(mounts)
    common = [
        'Register a node profile whose key, ssh_host, and remote_hosts.json name are all "%s".' % name,
        'Set disk_mounts to only this node\'s mounts: %s.' % mounts_text,
        'Sampling starts from fleet_probe.collect through fleet_monitor.collect_host. Do not add a collector named after this host.',
        'Driver version, per-pod VRAM, network rates, and disk IO come from that shared probe.',
        'K3s node list, FRP, MinIO, databases, and the reverse proxy stay platform services and are not part of this node plan.',
    ]
    if kind == 'cpu':
        head = [
            'cpu node: join the k3s agent and label yatterra/node=%s.' % name,
            'Do not advertise NVIDIA GPUs and do not install the NVIDIA device plugin.',
            'Do not set unified memory.',
        ]
    elif kind == 'gpu':
        head = [
            'gpu node: join the k3s agent, label yatterra/node=%s, and install the NVIDIA driver plus the NVIDIA device plugin so the node advertises nvidia.com/gpu.' % name,
            'This is a discrete-accelerator node. Do not set unified memory and do not write a discrete VRAM size into the profile.',
        ]
    else:
        head = [
            'unified memory node: join the k3s agent and label yatterra/node=%s.' % name,
            'Set unified_memory true. Leave discrete VRAM unset. System RAM and accelerator memory are one pool.',
            'Do not install a discrete-VRAM device profile and do not copy another machine\'s disk list.',
        ]
    return head + common


def render_plan(plan):
    """Stable text for check mode. No clock and no credential material."""
    profile = plan['profile']
    lines = [
        'node_install: check',
        'kind: %s' % plan['kind'],
        'name: %s' % plan['name'],
        'ssh_target: %s' % plan['ssh_target'],
        'ssh_user: %s' % plan['user'],
        'ssh_port: %s' % plan['port'],
        'arch: %s' % profile['arch'],
        'accelerator: %s' % profile['accelerator'],
        'advertise_nvidia_gpu: %s' % ('true' if profile['advertise_nvidia_gpu'] else 'false'),
        'unified_memory: %s' % ('true' if profile['unified_memory'] else 'false'),
        'discrete_vram_bytes: null',
        'disk_mounts: %s' % ' '.join(profile['disk_mounts']),
        'profile_key: %s' % plan['registration']['profile_key'],
        'ssh_host: %s' % plan['registration']['ssh_host'],
        'remote_hosts_name: %s' % plan['registration']['remote_hosts_name'],
        'probe: %s' % plan['registration']['probe'],
        'collector: %s' % plan['registration']['collector'],
        'per_host_collector: null',
        'steps:',
    ]
    lines.extend('  - %s' % step for step in plan['steps'])
    lines.append('registry_profile:')
    lines.append(json.dumps(registry_profile(plan), indent=2, sort_keys=True))
    lines.append('remote_host:')
    lines.append(json.dumps(plan['remote_host'], indent=2, sort_keys=True))
    return '\n'.join(lines) + '\n'


def main(argv=None):
    parser = argparse.ArgumentParser(description='Plan a new cpu, gpu, or unified-memory node.')
    parser.add_argument('--check', action='store_true', help='print the plan and change nothing')
    parser.add_argument('--kind', required=True)
    parser.add_argument('--name', required=True)
    parser.add_argument('--ssh', required=True)
    parser.add_argument('--mount', action='append', required=True)
    parser.add_argument('--user', default='sse')
    parser.add_argument('--port', default=22)
    parser.add_argument('--arch', default=None)
    args = parser.parse_args(argv)
    if not args.check:
        print('node_install: refusing to change the cluster without --check', file=sys.stderr)
        return 2
    try:
        plan = plan_node(args.name, args.kind, args.mount, args.ssh, arch=args.arch, user=args.user, port=args.port)
    except PlanError as exc:
        print('node_install: %s' % exc, file=sys.stderr)
        return 2
    sys.stdout.write(render_plan(plan))
    return 0


if __name__ == '__main__':
    sys.exit(main())
