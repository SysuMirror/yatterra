"""timeline: missing/corrupt file is inert, write is atomic, phases resolve.

TIMELINE_FILE is pointed at a temp path so the real file is never touched.
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import timeline


class TimelineCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.path = os.path.join(self.dir, "timeline.json")
        self._saved = timeline.TIMELINE_FILE
        timeline.TIMELINE_FILE = self.path
        self.addCleanup(self._restore)

    def _restore(self):
        timeline.TIMELINE_FILE = self._saved

    def _write_raw(self, text):
        with open(self.path, "w") as f:
            f.write(text)


class Read(TimelineCase):
    def test_missing_file_is_empty_and_shoulder(self):
        self.assertEqual(timeline.read(), {})
        self.assertEqual(timeline.phase(1000), "shoulder")
        self.assertFalse(timeline.is_valley(1000))
        self.assertEqual(timeline.next_valley(1000), {})

    def test_malformed_json_is_inert(self):
        self._write_raw("{ not json")
        self.assertEqual(timeline.read(), {})
        self.assertEqual(timeline.phase(1000), "shoulder")

    def test_non_dict_is_inert(self):
        self._write_raw("[1,2,3]")
        self.assertEqual(timeline.read(), {})
        self.assertEqual(timeline.phase(1000), "shoulder")


class Write(TimelineCase):
    def test_roundtrip_stamps_and_is_atomic(self):
        out = timeline.write({"phase": "valley", "horizon_s": 86400})
        self.assertEqual(out["schema"], timeline.SCHEMA)
        self.assertIn("generated_ts", out)
        self.assertEqual(timeline.read()["phase"], "valley")
        self.assertFalse(os.path.exists(self.path + ".tmp"))  # atomic replace

    def test_write_non_dict_is_safe(self):
        timeline.write("nonsense")
        self.assertEqual(timeline.read().get("schema"), timeline.SCHEMA)

    def test_write_creates_parent_dir(self):
        nested = os.path.join(self.dir, "sub", "timeline.json")
        timeline.TIMELINE_FILE = nested
        timeline.write({"phase": "peak"})
        self.assertTrue(os.path.exists(nested))


class Phase(TimelineCase):
    def test_valid_phases_pass_through(self):
        for p in ("peak", "shoulder", "valley"):
            timeline.write({"phase": p})
            self.assertEqual(timeline.phase(1000), p)

    def test_garbage_phase_defaults_to_shoulder(self):
        timeline.write({"phase": "banana"})
        self.assertEqual(timeline.phase(1000), "shoulder")

    def test_now_inside_next_valley_window_reads_valley(self):
        timeline.write({"phase": "shoulder",
                        "next_valley": {"start": 100, "end": 200, "confidence": 0.6}})
        self.assertEqual(timeline.phase(150), "valley")
        self.assertTrue(timeline.is_valley(150))
        self.assertEqual(timeline.phase(250), "shoulder")

    def test_next_valley_and_peak_accessors(self):
        timeline.write({"next_valley": {"start": 100, "end": 200},
                        "next_peak": {"start": 300, "end": 400}})
        self.assertEqual(timeline.next_valley(0)["start"], 100)
        self.assertEqual(timeline.next_peak(0)["end"], 400)

    def test_group_phase_override(self):
        timeline.write({"phase": "peak",
                        "per_group": {"g1": {"phase": "valley"}}})
        self.assertEqual(timeline.group_phase("g1", 1000), "valley")
        self.assertEqual(timeline.group_phase("g2", 1000), "peak")


if __name__ == "__main__":
    unittest.main()
