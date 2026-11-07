"""billing_core: resource mapping, integer-cent rounding, degenerate inputs.

The money layer's correctness hinges on two things this file pins down: the
resource→usage-field mapping (so a rename can't silently bill the wrong
column) and round-half-up to integer cents (so no float drift ever reaches the
ledger).
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import billing_core as bc

TOTALS = {
    "core_hours": 10.0,
    "request_core_hours": 16.0,
    "compute_card_hours": 2.5,
    "gpu_mem_gib_hours": 4.0,
    "mem_gib_hours": 8.0,
    "storage_home_gib_hours": 1.5,
    "storage_minio_gib_hours": 0.5,
    "storage_quota_gib_hours": 3.0,
}


class Units(unittest.TestCase):
    def test_actual_basis_uses_measured_cpu(self):
        u = bc.units_for(TOTALS, "actual")
        self.assertEqual(u["cpu_core_hour"], 10.0)
        self.assertEqual(u["gpu_card_hour"], 2.5)

    def test_request_basis_switches_only_cpu(self):
        a = bc.units_for(TOTALS, "actual")
        r = bc.units_for(TOTALS, "request")
        self.assertEqual(r["cpu_core_hour"], 16.0)
        self.assertEqual(a["gpu_mem_gib_hour"], r["gpu_mem_gib_hour"])

    def test_every_resource_key_resolves(self):
        u = bc.units_for(TOTALS)
        for key in bc.RESOURCE_KEYS:
            self.assertIn(key, u)
            self.assertGreaterEqual(u[key], 0)

    def test_missing_and_garbage_are_zero(self):
        u = bc.units_for({"core_hours": None, "mem_gib_hours": "nonsense"})
        self.assertEqual(u["cpu_core_hour"], 0)
        self.assertEqual(u["mem_gib_hour"], 0)
        self.assertEqual(bc.units_for(None)["cpu_core_hour"], 0)


class Costs(unittest.TestCase):
    def test_round_half_up(self):
        # 0.35 -> 0, 0.5 -> 1, 1.5 -> 2 (Python's banker round would differ)
        self.assertEqual(bc.cost_cents({"core_hours": 1}, {"cpu_core_hour": 0.35})["cpu_core_hour"], 0)
        self.assertEqual(bc.cost_cents({"core_hours": 1}, {"cpu_core_hour": 0.5})["cpu_core_hour"], 1)
        self.assertEqual(bc.cost_cents({"core_hours": 1}, {"cpu_core_hour": 1.5})["cpu_core_hour"], 2)

    def test_total_is_sum_of_rounded_keys(self):
        prices = {"cpu_core_hour": 0.35, "mem_gib_hour": 0.5}
        out = bc.cost_cents({"core_hours": 1, "mem_gib_hours": 1}, prices)
        self.assertEqual(out["total_cents"], out["cpu_core_hour"] + out["mem_gib_hour"])

    def test_unknown_key_in_prices_is_ignored(self):
        out = bc.cost_cents({"core_hours": 10}, {"not_a_resource": 99})
        self.assertEqual(out["total_cents"], 0)

    def test_missing_prices_bill_nothing(self):
        out = bc.cost_cents(TOTALS, {})
        self.assertEqual(out["total_cents"], 0)

    def test_negative_usage_cannot_credit(self):
        out = bc.cost_cents({"core_hours": -100}, {"cpu_core_hour": 10})
        self.assertEqual(out["total_cents"], 0)

    def test_breakdown_rows_cover_all_keys(self):
        rows = bc.breakdown(TOTALS, {"cpu_core_hour": 2})
        self.assertEqual(len(rows), len(bc.RESOURCE_KEYS))
        self.assertEqual(sum(r["cost_cents"] for r in rows), 10 * 2)


if __name__ == "__main__":
    unittest.main()
