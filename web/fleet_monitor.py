"""Fleet inventory, bounded SSH collection, and SQLite history. No import threads."""
import json
import math
import re
import os
from pathlib import Path
import shlex
import sqlite3
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import closing

import fleet_probe

import siteconf

DB_PATH = os.environ.get('YATTERRA_FLEET_DB', siteconf.web_path('fleet_metrics.db'))
CONFIG_PATH = os.environ.get('YATTERRA_FLEET_CONFIG', siteconf.path('remote_hosts.json'))
RETENTION = 7 * 86400


def inventory():
    hosts = [{'id': 'local', 'name': os.environ.get('YATTERRA_LOCAL_HOST_NAME', 'gpu4090'),
              'kind': 'local', 'mounts': siteconf.DISK_MOUNTS}]
    try:
        with open(CONFIG_PATH) as stream:
            configs = json.load(stream)
    except FileNotFoundError:
        configs = []
    if not isinstance(configs, list):
        raise ValueError('Invalid fleet configuration')
    seen = {'local'}
    for cfg in configs:
        if not isinstance(cfg, dict):
            raise ValueError('Invalid fleet host configuration')
        name = cfg.get('name')
        if not isinstance(name, str) or not name or '/' in name or name in seen:
            raise ValueError('Invalid or duplicate fleet host name')
        target = cfg.get('host', '')
        user = cfg.get('user', '')
        if not isinstance(target, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.:%_-]*', target):
            raise ValueError('Invalid fleet SSH host')
        if not isinstance(user, str) or (user and not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]*', user)):
            raise ValueError('Invalid fleet SSH user')
        if not 1 <= int(cfg.get('port', 22)) <= 65535:
            raise ValueError('Invalid fleet SSH port')
        mounts = cfg.get('mounts', ['/'])
        if not isinstance(mounts, list) or len(mounts) > 32 or any(not isinstance(m, str) or not m.startswith('/') or '\x00' in m for m in mounts):
            raise ValueError('Invalid fleet mounts')
        seen.add(name)
        hosts.append(dict(cfg, id=name, kind='remote'))
    return hosts


def public_host(cfg):
    return {key: cfg.get(key, '') for key in ('id', 'name', 'kind', 'desc')}


def collect_host(cfg):
    started = time.time()
    try:
        mounts = cfg.get('mounts', ['/'])
        if cfg['kind'] == 'local':
            data = fleet_probe.collect(mounts)
        else:
            command = ['ssh', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=5',
                       '-o', 'ServerAliveCountMax=2', '-o', 'StrictHostKeyChecking=accept-new',
                       '-p', str(int(cfg.get('port', 22)))]
            env = os.environ.copy()
            if cfg.get('password'):
                env['SSHPASS'] = cfg['password']
                command = ['sshpass', '-e'] + command
            else:
                command += ['-o', 'BatchMode=yes']
            target = str(cfg.get('host', ''))
            if cfg.get('user'):
                target = str(cfg['user']) + '@' + target
            remote = 'python3 - ' + shlex.quote(json.dumps(mounts))
            command += ['--', target, remote]
            script = Path(fleet_probe.__file__).read_text()
            result = subprocess.run(command, input=script, capture_output=True, text=True,
                                    timeout=25, env=env)
            if result.returncode:
                raise RuntimeError('SSH collection failed')
            data = json.loads(result.stdout)
            if (not isinstance(data, dict) or
                    any(not isinstance(data.get(k), dict) for k in ('cpu', 'memory', 'swap', 'errors')) or
                    any(not isinstance(data.get(k), list) for k in ('disks', 'gpus'))):
                raise ValueError('Invalid probe response')
        json.dumps(data, allow_nan=False)
        return dict(public_host(cfg), timestamp=started, status='partial' if data.get('errors') else 'online', data=data)
    except Exception as exc:
        # Never persist raw SSH stderr/exception strings: they may contain secrets.
        error = 'Collection timed out' if isinstance(exc, subprocess.TimeoutExpired) else 'Collection failed'
        return dict(public_host(cfg), timestamp=started, status='offline', data=None, error=error)


class Store:
    def __init__(self, path=None):
        self.path = str(path or DB_PATH)

    def initialize(self):
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.path, timeout=10)) as db, db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS fleet_samples (host TEXT NOT NULL, ts REAL NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(host, ts))')
            db.execute('CREATE INDEX IF NOT EXISTS fleet_samples_ts ON fleet_samples(ts)')

    def append(self, sample):
        with closing(sqlite3.connect(self.path, timeout=10)) as db, db:
            db.execute('INSERT OR REPLACE INTO fleet_samples VALUES(?,?,?)',
                       (sample['id'], sample['timestamp'], json.dumps(sample, allow_nan=False)))

    def prune(self, now=None):
        with closing(sqlite3.connect(self.path, timeout=10)) as db, db:
            db.execute('DELETE FROM fleet_samples WHERE ts < ?', ((time.time() if now is None else now) - RETENTION,))

    def _read(self, query, args):
        if not Path(self.path).exists():
            return []
        with closing(sqlite3.connect(Path(self.path).resolve().as_uri() + '?mode=ro', uri=True, timeout=5)) as db:
            return [json.loads(row[0]) for row in db.execute(query, args)]

    def latest(self, host):
        rows = self._read('SELECT payload FROM fleet_samples WHERE host=? ORDER BY ts DESC LIMIT 1', (host,))
        return rows[0] if rows else None

    def history(self, host, since, until, limit=240):
        if not 2 <= limit <= 2000:
            raise ValueError('limit must be between 2 and 2000')
        if not all(math.isfinite(x) for x in (since, until)) or since > until or until - since > RETENTION:
            raise ValueError('Invalid history window')
        # Select bounded, evenly spaced observations spanning the whole window.
        return self._read('''WITH ranked AS (
            SELECT payload, ROW_NUMBER() OVER (ORDER BY ts) AS rn,
                   COUNT(*) OVER () AS n FROM fleet_samples WHERE host=? AND ts>=? AND ts<=?
        ) SELECT payload FROM ranked WHERE n<=? OR rn=1 OR rn=n OR
            CAST((rn-1)*(?-1)*1.0/(n-1) AS INTEGER) > CAST((rn-2)*(?-1)*1.0/(n-1) AS INTEGER)
            ORDER BY rn''', (host, since, until, limit, limit, limit))


def snapshot(store=None):
    store = store or Store()
    now = time.time()
    rows = []
    for cfg in inventory():
        sample = store.latest(cfg['id'])
        row = sample or dict(public_host(cfg), timestamp=None, status='unknown', data=None)
        row['stale'] = sample is None or now - sample['timestamp'] > 120
        row['age_seconds'] = max(0, now - sample['timestamp']) if sample else None
        rows.append(row)
    return {'schema_version': 1, 'timestamp': now, 'hosts': rows}


def sample_once(store):
    counts = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(collect_host, cfg) for cfg in inventory()]
        for future in as_completed(futures):
            sample = future.result()
            store.append(sample)
            counts[sample['status']] = counts.get(sample['status'], 0) + 1
    store.prune()
    return counts
