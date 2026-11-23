"""Read-only Linux probe, also sent verbatim over SSH; standard library only.

Units: bytes, seconds, watts, degrees Celsius, and percentages (0..100).
Unknown/unsupported readings are null, never fabricated zeroes.
"""
import csv
import io
import json
import math
import os
import re
import shutil
import socket
import subprocess
import sys
import time


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) and result >= 0 else None
    except (TypeError, ValueError):
        return None


def cpu_counters():
    with open('/proc/stat') as stream:
        values = [int(x) for x in stream.readline().split()[1:9]]
    return sum(values), values[3] + values[4]


def cpu_percent(before, after):
    total, idle = after[0] - before[0], after[1] - before[1]
    if total <= 0 or idle < 0 or idle > total:
        return None
    return round(100 * (total - idle) / total, 2)


def counter_rate(previous, current, elapsed):
    """Return a non-negative counter rate, or null for first/reset samples."""
    if previous is None or current is None or elapsed <= 0:
        return None
    try:
        delta = float(current) - float(previous)
        return round(delta / elapsed, 3) if delta >= 0 and math.isfinite(delta) else None
    except (TypeError, ValueError):
        return None


def machine_identity(cpuinfo, arch, product=None):
    """CPU model and architecture from /proc/cpuinfo text. Empty fields stay null."""
    model = None
    for line in str(cpuinfo or '').splitlines():
        key, sep, value = line.partition(':')
        if not sep:
            continue
        key = key.strip().lower()
        value = value.strip()
        if key == 'model name' and value:
            model = value
            break
        if key == 'model' and value and not model:
            model = value
    product = str(product or '').strip() or None
    arch = str(arch or '').strip() or None
    return {'arch': arch, 'cpu_model': model, 'product': product}


def read_machine():
    try:
        with open('/proc/cpuinfo') as stream:
            cpuinfo = stream.read()
    except OSError:
        cpuinfo = ''
    product = None
    try:
        with open('/sys/class/dmi/id/product_name') as stream:
            product = stream.read()
    except OSError:
        product = None
    try:
        arch = os.uname().machine
    except AttributeError:
        arch = None
    return machine_identity(cpuinfo, arch, product)


def clean_text(value):
    text = str(value or '').strip()
    if not text or text.upper() in {'N/A', '[N/A]', '[NOT SUPPORTED]'}:
        return None
    return text


def parse_gpus(text):
    result = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) not in (9, 10):
            continue
        cells = [v.strip() for v in row]
        idx, uuid, name, util, used, total, temp, power, limit = cells[:9]
        def mib(value):
            value = number(value)
            return int(value * 1024 ** 2) if value is not None else None
        gpu = {'id': uuid or idx, 'index': number(idx), 'name': name,
               'utilization_pct': number(util), 'memory_used_bytes': mib(used),
               'memory_total_bytes': mib(total), 'temperature_c': number(temp),
               'power_watts': number(power), 'power_limit_watts': number(limit)}
        if len(cells) == 10:
            driver = clean_text(cells[9])
            if driver:
                gpu['driver_version'] = driver
        result.append(gpu)
    return result


_SKIP_NET = ('veth', 'cni', 'docker', 'flannel', 'br-', 'virbr')
_NET_KEYS = ('rx_bytes', 'tx_bytes', 'rx_packets', 'tx_packets', 'rx_dropped', 'tx_dropped', 'rx_errors', 'tx_errors')
_POD_UID = re.compile(r'kubepods[^/\s]*?-pod([0-9a-f_]+)\.slice')


def parse_net_dev(text):
    """Aggregate counters from /proc/net/dev text. Loopback and veth mirrors are skipped."""
    totals = {key: 0 for key in _NET_KEYS}
    for line in str(text or '').splitlines():
        if ':' not in line:
            continue
        name, raw = line.split(':', 1)
        name = name.strip()
        if not name or name == 'lo' or name.startswith(_SKIP_NET):
            continue
        vals = raw.split()
        if len(vals) < 16:
            continue
        row = {key: int(vals[i]) for key, i in zip(_NET_KEYS, (0, 8, 1, 9, 3, 11, 2, 10))}
        for key, value in row.items():
            totals[key] += value
    return totals


def parse_diskstats(text):
    """Per-device counters from /proc/diskstats text, including partitions."""
    devices = {}
    for line in str(text or '').splitlines():
        parts = line.split()
        if len(parts) < 14:
            continue
        try:
            vals = [int(part) for part in parts[3:14]]
        except ValueError:
            continue
        devices[parts[2]] = {
            'read_ops': vals[0], 'read_bytes': vals[2] * 512,
            'write_ops': vals[4], 'write_bytes': vals[6] * 512,
            'io_ms': vals[9], 'weighted_io_ms': int(parts[13]),
        }
    return devices


def _unescape_mount(value):
    return (value.replace('\\040', ' ').replace('\\011', '\t')
            .replace('\\012', '\n').replace('\\134', '\\'))


def parse_mountinfo(text):
    """Return (mountpoint, source) rows. Later rows overlay earlier ones."""
    rows = []
    for line in str(text or '').splitlines():
        parts = line.split()
        if '-' not in parts:
            continue
        dash = parts.index('-')
        if dash < 5 or dash + 2 >= len(parts):
            continue
        rows.append((_unescape_mount(parts[4]), parts[dash + 2]))
    return rows


def block_device_name(source, resolve=os.path.realpath):
    """Kernel device name for a /dev source, or null for non-block mounts."""
    if not source or not str(source).startswith('/dev/'):
        return None
    try:
        real = resolve(source)
    except OSError:
        real = source
    name = os.path.basename(real or '')
    return name or None


def network_sample(before_text, after_text, elapsed):
    """Counters plus rates. Missing files stay null; a real zero delta stays zero."""
    before = parse_net_dev(before_text) if before_text is not None else None
    after = parse_net_dev(after_text) if after_text is not None else None
    sample = {}
    for key in _NET_KEYS:
        sample[key] = None if after is None else after[key]
        sample[key + '_per_sec'] = counter_rate(
            None if before is None else before[key],
            None if after is None else after[key], elapsed)
    for direction, packets, dropped in (('rx', 'rx_packets', 'rx_dropped'), ('tx', 'tx_packets', 'tx_dropped')):
        packet_rate = sample[packets + '_per_sec']
        drop_rate = sample[dropped + '_per_sec']
        if packet_rate is None or drop_rate is None:
            sample[direction + '_drop_pct'] = None
            continue
        denom = packet_rate + drop_rate
        sample[direction + '_drop_pct'] = round(100 * drop_rate / denom, 4) if denom > 0 else None
    return sample


def fill_disk_rates(disks, mountinfo_text, before, after, elapsed, resolve=os.path.realpath):
    """Fill each mount's byte counters and rates. Returns the summed disk_io block."""
    chosen = {}
    for mount, source in parse_mountinfo(mountinfo_text):
        chosen[mount] = source
    summed = {key: [] for key in ('read_bytes_per_sec', 'write_bytes_per_sec', 'read_ops_per_sec', 'write_ops_per_sec')}
    pairs = (('read_bytes', 'read_rate_bytes_sec', 'read_bytes_per_sec'),
             ('write_bytes', 'write_rate_bytes_sec', 'write_bytes_per_sec'),
             ('read_ops', 'read_ops_per_sec', 'read_ops_per_sec'),
             ('write_ops', 'write_ops_per_sec', 'write_ops_per_sec'))
    for disk in disks:
        name = block_device_name(chosen.get(disk.get('mount')), resolve)
        current = (after or {}).get(name) if name else None
        previous = (before or {}).get(name) if name else None
        if not current:
            continue
        disk['read_bytes'] = current['read_bytes']
        disk['write_bytes'] = current['write_bytes']
        for field, rate_key, sum_key in pairs:
            rate = counter_rate(None if previous is None else previous[field], current[field], elapsed)
            disk[rate_key] = rate
            if rate is not None:
                summed[sum_key].append(rate)
    return {key: round(sum(values), 3) if values else None for key, values in summed.items()}


def pod_uid_from_cgroup(text):
    match = _POD_UID.search(text or '')
    return match.group(1).replace('_', '-') if match else None


def hostname_from_environ(blob):
    if not blob:
        return None
    if isinstance(blob, str):
        blob = blob.encode()
    for part in blob.split(b'\0'):
        if part.startswith(b'HOSTNAME='):
            value = part.split(b'=', 1)[1].decode('utf-8', 'replace').strip()
            return value or None
    return None


def parse_compute_apps(text, uuid_to_index):
    apps = []
    for row in csv.reader(io.StringIO(text or '')):
        if len(row) < 3:
            continue
        uuid, pid, mem = row[0].strip(), row[1].strip(), row[-1].strip()
        index = uuid_to_index.get(uuid)
        mem_mib = number(mem)
        if index is None or not pid.isdigit() or mem_mib is None:
            continue
        apps.append({'index': index, 'pid': pid, 'mem': int(mem_mib)})
    return apps


def parse_pmon(text):
    """Per-process SM% from nvidia-smi pmon. '-' means no sample, not zero."""
    out = {}
    for line in str(text or '').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split()
        if len(parts) < 4 or not parts[0].isdigit() or not parts[1].isdigit() or parts[3] in ('-', ''):
            continue
        sm = number(parts[3])
        if sm is None:
            continue
        out[(int(parts[0]), parts[1])] = sm
    return out


def _index_key(value):
    parsed = number(value)
    if parsed is None:
        return value
    return int(parsed) if parsed == int(parsed) else parsed


def attribute_pods(apps, cgroups, environs=None, pmon=None):
    """VRAM by this host's own pod cgroups. Host processes are left out.

    ``name`` stays null when the pod hostname is unreadable. ``util`` stays
    null unless every process on that pod had a pmon sample. Neither is invented.
    """
    environs = environs or {}
    pmon = pmon or {}
    buckets = {}
    for app in apps:
        pid = str(app['pid'])
        uid = pod_uid_from_cgroup(cgroups.get(pid, ''))
        if not uid:
            continue
        key = (_index_key(app['index']), uid)
        cell = buckets.setdefault(key, {'mem': 0, 'utils': [], 'name': None})
        cell['mem'] += int(app['mem'])
        cell['utils'].append(pmon.get((_index_key(app['index']), pid)))
        if not cell['name']:
            cell['name'] = hostname_from_environ(environs.get(pid))
    grouped = {}
    for (index, uid), cell in buckets.items():
        util = round(sum(cell['utils']), 1) if cell['utils'] and all(item is not None for item in cell['utils']) else None
        grouped.setdefault(index, []).append({'name': cell['name'], 'uid': uid, 'mem': cell['mem'], 'util': util})
    for rows in grouped.values():
        rows.sort(key=lambda row: row['mem'], reverse=True)
    return grouped


def _read(path):
    try:
        with open(path, encoding='utf-8', errors='replace') as stream:
            return stream.read()
    except OSError:
        return None


def _read_bytes(path):
    try:
        with open(path, 'rb') as stream:
            return stream.read()
    except OSError:
        return b''


def _gpu_pods(gpus):
    """Attach this machine's own pod rows. Leaves pods unset when the query fails."""
    try:
        apps_run = subprocess.run(
            ['nvidia-smi', '--query-compute-apps=gpu_uuid,pid,used_memory', '--format=csv,noheader,nounits'],
            capture_output=True, text=True, timeout=8)
        if apps_run.returncode:
            return
        uuid_to_index = {gpu.get('id'): gpu.get('index') for gpu in gpus if gpu.get('id')}
        apps = parse_compute_apps(apps_run.stdout, uuid_to_index)
        pmon = {}
        if apps:
            pmon_run = subprocess.run(['nvidia-smi', 'pmon', '-c', '1'], capture_output=True, text=True, timeout=8)
            if pmon_run.returncode == 0:
                pmon = parse_pmon(pmon_run.stdout)
        cgroups = {}
        environs = {}
        for pid in {app['pid'] for app in apps}:
            cgroups[pid] = _read('/proc/%s/cgroup' % pid) or ''
            environs[pid] = _read_bytes('/proc/%s/environ' % pid)
        grouped = attribute_pods(apps, cgroups, environs, pmon)
    except (OSError, subprocess.TimeoutExpired):
        return
    for gpu in gpus:
        gpu['pods'] = grouped.get(_index_key(gpu.get('index')), [])


def collect(mounts=None):
    """One sample for whichever machine this process is on.

    Driver, per-pod VRAM, network and disk IO are part of this sample.
    Callers do not pass a host name and there is no per-machine branch.
    """
    out = {'hostname': socket.gethostname(), 'cpu': {'count': os.cpu_count(), 'usage_pct': None,
           'load1': None, 'load5': None, 'load15': None}, 'memory': dict.fromkeys(('total_bytes', 'used_bytes', 'available_bytes', 'usage_pct')),
           'swap': dict.fromkeys(('total_bytes', 'used_bytes', 'available_bytes', 'usage_pct')),
           'disks': [], 'gpus': [], 'machine': {'arch': None, 'cpu_model': None, 'product': None},
           'nvidia': {'driver_version': None, 'count': 0},
           'network': network_sample(None, None, 0), 'disk_io': dict.fromkeys(('read_bytes_per_sec', 'write_bytes_per_sec', 'read_ops_per_sec', 'write_ops_per_sec')),
           'uptime_seconds': None, 'errors': {}}
    net_before = _read('/proc/net/dev')
    disk_before_text = _read('/proc/diskstats')
    started = time.monotonic()
    try:
        before = cpu_counters()
    except (OSError, ValueError, IndexError):
        before = None
        out['errors']['cpu'] = 'CPU counters unavailable'
    time.sleep(0.2)
    elapsed = time.monotonic() - started
    if before is not None:
        try:
            out['cpu']['usage_pct'] = cpu_percent(before, cpu_counters())
            out['cpu'].update(zip(('load1', 'load5', 'load15'), os.getloadavg()))
            out['errors'].pop('cpu', None)
        except (OSError, ValueError, IndexError):
            out['errors']['cpu'] = 'CPU counters unavailable'
    out['network'] = network_sample(net_before, _read('/proc/net/dev'), elapsed)
    try:
        with open('/proc/meminfo') as stream:
            mem = {p[0].rstrip(':'): int(p[1]) * 1024 for p in (line.split() for line in stream) if len(p) >= 2}
        for key, total, available in [('memory', mem['MemTotal'], mem['MemAvailable']),
                                      ('swap', mem['SwapTotal'], mem['SwapFree'])]:
            used = max(0, total - available)
            out[key] = {'total_bytes': total, 'used_bytes': used, 'available_bytes': available,
                        'usage_pct': round(100 * used / total, 2) if total else 0.0}
    except (OSError, ValueError, KeyError):
        out['errors']['memory'] = 'Memory counters unavailable'
    try:
        with open('/proc/uptime') as stream:
            out['uptime_seconds'] = float(stream.read().split()[0])
    except (OSError, ValueError, IndexError):
        out['errors']['uptime'] = 'Uptime unavailable'
    if mounts is None:
        mounts = ['/']
    for mount in mounts:
        disk = {'mount': mount, 'total_bytes': None, 'used_bytes': None, 'available_bytes': None,
                'usage_pct': None, 'read_bytes': None, 'write_bytes': None,
                'read_rate_bytes_sec': None, 'write_rate_bytes_sec': None}
        try:
            usage = shutil.disk_usage(mount)
            disk.update(total_bytes=usage.total, used_bytes=usage.used, available_bytes=usage.free,
                        usage_pct=round(100 * usage.used / usage.total, 2) if usage.total else None)
        except OSError:
            disk['error'] = 'Mount unavailable'
            out['errors']['disk'] = 'One or more mounts unavailable'
        out['disks'].append(disk)
    disk_after_text = _read('/proc/diskstats')
    out['disk_io'] = fill_disk_rates(
        out['disks'], _read('/proc/self/mountinfo'),
        parse_diskstats(disk_before_text) if disk_before_text is not None else None,
        parse_diskstats(disk_after_text) if disk_after_text is not None else None,
        elapsed)
    try:
        out['machine'] = read_machine()
    except OSError:
        out['errors']['machine'] = 'Machine identity unavailable'
    if shutil.which('nvidia-smi'):
        try:
            result = subprocess.run(['nvidia-smi', '--query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,driver_version',
                                     '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=8)
            if result.returncode:
                out['errors']['gpu'] = 'GPU query failed'
            else:
                out['gpus'] = parse_gpus(result.stdout)
                _gpu_pods(out['gpus'])
        except (OSError, subprocess.TimeoutExpired):
            out['errors']['gpu'] = 'GPU query unavailable'
    versions = [gpu.get('driver_version') for gpu in out['gpus'] if gpu.get('driver_version')]
    out['nvidia'] = {'driver_version': versions[0] if versions else None, 'count': len(out['gpus'])}
    out['collected_at'] = time.time()
    return out


if __name__ == '__main__':
    print(json.dumps(collect(json.loads(sys.argv[1]) if len(sys.argv) > 1 else None), allow_nan=False))
