"""Shipped UX inventory must match the route table and the edited sources.

Run from /opt/yatterra/web:
  python3 -m unittest tests.test_ux_inventory -v
"""
import json
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INV = ROOT / "frontend" / "src" / "ux" / "inventory.json"
APP = ROOT / "frontend" / "src" / "App.tsx"
ROUTES = ROOT / "frontend" / "src" / "lib" / "appRoutes.ts"


class UxInventoryTests(unittest.TestCase):
    def test_shipped_inventory_covers_pages_and_markers(self):
        self.assertTrue(INV.is_file(), INV)
        raw = INV.read_text()
        items = json.loads(raw)
        bridge = (ROOT / "frontend" / "src" / "ux" / "inventory.ts").read_text()
        app = APP.read_text()
        self.assertIn("inventory.json", bridge)
        self.assertIn("UX_INVENTORY", app)

        improvements = [i for i in items if i["kind"] in ("fix", "radical")]
        radicals = [i for i in items if i["kind"] == "radical"]
        radical_pages = {i["page"] for i in radicals}
        print(f"improvements={len(improvements)} radicals={len(radicals)} radical_pages={len(radical_pages)}")
        self.assertGreaterEqual(len(improvements), 50)
        self.assertGreaterEqual(len(radicals), 10)
        self.assertGreaterEqual(len(radical_pages), 10)

        markers = []
        for item in items:
            self.assertIn(item["kind"], ("fix", "radical", "reviewed"))
            self.assertTrue(item["inconvenience"].strip())
            src = ROOT / item["source"]
            text = src.read_text()
            self.assertIn(item["marker"], text, item["marker"])
            if item["kind"] != "reviewed":
                markers.append(item["marker"])
        self.assertEqual(len(markers), len(set(markers)))

        route_text = ROUTES.read_text()
        required = set(re.findall(r"path:\s*'([^']+)'", route_text))
        self.assertGreaterEqual(len(required), 20)
        if 'path="/reports"' in app or "path='/reports'" in app:
            required.add("/reports")
        if 'path="/login"' in app:
            required.add("/login")
        if 'path="/"' in app:
            required.add("/")
        if 'path="*"' in app:
            required.add("*")
        pages = {i["page"] for i in items}
        missing = sorted(required - pages)
        self.assertEqual(missing, [], missing)

    def test_piles_keep_unknown_status_and_ide_recovery_hits_list(self):
        not_found = (ROOT / "frontend/src/routes/not-found.tsx").read_text()
        pods = (ROOT / "frontend/src/routes/pods/index.tsx").read_text()
        self.assertIn("recoveryPath(", not_found)
        self.assertNotIn(".replace(/\\/:[^/]+/g, '')", not_found)
        self.assertIn("podPiles(visiblePods)", pods)
        probe = r"""
import { readFileSync } from 'node:fs'
import { recoveryPath } from './frontend/src/lib/uxRecover.ts'
import { podPiles } from './frontend/src/lib/podPiles.ts'

const routes = readFileSync('./frontend/src/lib/appRoutes.ts', 'utf8')
const paths = [...routes.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1])
const staticPaths = paths.filter((p) => !p.includes(':'))
const detail = paths.find((p) => p === '/pods/:name')
const ide = paths.find((p) => p === '/pods/:name/ide')
if (!detail || !ide) throw new Error('route table lost pod detail or pod IDE')
const detailHref = recoveryPath(detail, staticPaths)
const ideHref = recoveryPath(ide, staticPaths)
if (detailHref !== '/pods') throw new Error('pod detail recovery ' + detailHref)
if (ideHref !== '/ide') throw new Error('pod IDE recovery ' + ideHref)
if (ideHref === '/pods/ide') throw new Error('pod IDE recovery still lands on /pods/ide')
for (const path of paths) {
  const href = recoveryPath(path, staticPaths)
  if (href.includes(':') || !staticPaths.includes(href)) throw new Error(path + ' -> ' + href)
}
const sample = [
  { name: 'run', status: 'Running' },
  { name: 'unk', status: 'Unknown' },
  { name: 'err', status: 'Error' },
  { name: 'crash', status: 'CrashLoopBackOff' },
  { name: 'blank', status: '' },
]
const piles = podPiles(sample)
const names = piles.flatMap((pile) => pile.pods.map((pod) => pod.name)).sort()
if (names.join(',') !== ['blank', 'crash', 'err', 'run', 'unk'].join(',')) throw new Error(names.join(','))
for (const status of ['Running', 'Unknown', 'Error', 'CrashLoopBackOff', 'Other']) {
  if (!piles.some((pile) => pile.status === status)) throw new Error('missing pile ' + status)
}
console.log('behavior-ok')
"""
        run = subprocess.run(
            ["node", "--experimental-strip-types", "--input-type=module", "-e", probe],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("behavior-ok", run.stdout)


if __name__ == "__main__":
    unittest.main()
