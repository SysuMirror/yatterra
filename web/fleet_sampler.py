"""Single-writer fleet sampler: python3 fleet_sampler.py [--once]."""
import argparse
import fcntl
import logging
import os
from pathlib import Path
import signal
import threading
import time

from fleet_monitor import Store, sample_once


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--interval', type=int, default=15)
    args = parser.parse_args()
    if args.interval < 5:
        parser.error('interval must be at least 5 seconds')
    logging.basicConfig(level=logging.INFO)
    os.umask(0o027)
    store = Store()
    Path(store.path).parent.mkdir(parents=True, exist_ok=True)
    with open(store.path + '.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.exit(1, 'Another fleet sampler owns this database\n')
        store.initialize()
        stop = threading.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: stop.set())
        while not stop.is_set():
            started = time.monotonic()
            try:
                counts = sample_once(store)
                logging.info('Fleet cycle complete in %.1fs: %s', time.monotonic() - started, counts)
            except Exception as exc:
                logging.error('Fleet sampling failed (%s)', type(exc).__name__)
                if args.once:
                    raise
            if args.once:
                break
            stop.wait(max(1, args.interval - (time.monotonic() - started)))


if __name__ == '__main__':
    main()
