"""Read-only Linux probe, also sent verbatim over SSH; standard library only.

Units: bytes, seconds, watts, degrees Celsius, and percentages (0..100).
Unknown/unsupported readings are null, never fabricated zeroes.
"""
import csv
import io
import json
import math
import os
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


def parse_gpus(text):
    result = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) != 9:
            continue
        idx, uuid, name, util, used, total, temp, power, limit = [v.strip() for v in row]
        def mib(value):
            value = number(value)
            return int(value * 1024 ** 2) if value is not None else None
        result.append({'id': uuid or idx, 'index': number(idx), 'name': name,
                       'utilization_pct': number(util), 'memory_used_bytes': mib(used),
                       'memory_total_bytes': mib(total), 'temperature_c': number(temp),
                       'power_watts': number(power), 'power_limit_watts': number(limit)})
    return result


def collect(mounts=None):
    out = {'hostname': socket.gethostname(), 'cpu': {'count': os.cpu_count(), 'usage_pct': None,
           'load1': None, 'load5': None, 'load15': None}, 'memory': dict.fromkeys(('total_bytes', 'used_bytes', 'available_bytes', 'usage_pct')),
           'swap': dict.fromkeys(('total_bytes', 'used_bytes', 'available_bytes', 'usage_pct')),
           'disks': [], 'gpus': [], 'uptime_seconds': None, 'errors': {}}
    try:
        before = cpu_counters()
        time.sleep(0.2)
        out['cpu']['usage_pct'] = cpu_percent(before, cpu_counters())
        out['cpu'].update(zip(('load1', 'load5', 'load15'), os.getloadavg()))
    except (OSError, ValueError, IndexError):
        out['errors']['cpu'] = 'CPU counters unavailable'
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
    for mount in mounts or ['/']:
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
    if shutil.which('nvidia-smi'):
        try:
            result = subprocess.run(['nvidia-smi', '--query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit',
                                     '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=8)
            if result.returncode:
                out['errors']['gpu'] = 'GPU query failed'
            else:
                out['gpus'] = parse_gpus(result.stdout)
        except (OSError, subprocess.TimeoutExpired):
            out['errors']['gpu'] = 'GPU query unavailable'
    out['collected_at'] = time.time()
    return out


if __name__ == '__main__':
    print(json.dumps(collect(json.loads(sys.argv[1]) if len(sys.argv) > 1 else None), allow_nan=False))
