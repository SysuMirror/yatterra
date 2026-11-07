#!/usr/bin/env python3
"""Pure billing arithmetic: physical usage → money.

No I/O, no DB, no clock — everything here is a function of its arguments so it
can be unit-tested and reasoned about in isolation.  The money layer proper
(prices, balances, ledger) lives in ``billing_store``; the metering layer
(second-integrals) lives in ``usage_store``.  This module is the bridge.

Money is handled as **integer cents** end-to-end.  Unit prices are fractional
(cents per unit) and the per-period cost is rounded half-up once, so a long
period's total never drifts from the sum of its rounded buckets by more than
the rounding of the final step.

Resource keys are stable strings — they are the primary key of
``billing_prices`` and the ``resource_key`` column of the ledger, so renaming
one is a data migration, not a refactor.
"""
from decimal import Decimal, ROUND_HALF_UP

# ── resource keys ────────────────────────────────────────────────
# key                       → field in a ``UsageTotals`` / ``_base()`` dict
RESOURCE_UNITS = {
    "cpu_core_hour": ("core_hours", "request_core_hours"),
    "gpu_card_hour": ("compute_card_hours",),
    "gpu_mem_gib_hour": ("gpu_mem_gib_hours",),
    "mem_gib_hour": ("mem_gib_hours",),
    "storage_home_gib_hour": ("storage_home_gib_hours",),
    "storage_minio_gib_hour": ("storage_minio_gib_hours",),
    "storage_quota_gib_hour": ("storage_quota_gib_hours",),
}
RESOURCE_KEYS = tuple(RESOURCE_UNITS)

# Human labels for the UI / API (key → 中文名).
RESOURCE_LABELS = {
    "cpu_core_hour": "CPU 核时",
    "gpu_card_hour": "GPU 算力卡时",
    "gpu_mem_gib_hour": "GPU 显存 GiB·h",
    "mem_gib_hour": "内存 GiB·h",
    "storage_home_gib_hour": "存储·组目录 GiB·h",
    "storage_minio_gib_hour": "存储·对象桶 GiB·h",
    "storage_quota_gib_hour": "存储·配额 GiB·h",
}

BASES = ("actual", "request")

_CENT = Decimal("1")


def _dec(x):
    """Coerce to a finite, non-negative Decimal (garbage → 0)."""
    try:
        d = Decimal(str(x))
    except Exception:
        return Decimal(0)
    if not d.is_finite() or d < 0:
        return Decimal(0)
    return d


def units_for(totals, basis="actual"):
    """Physical usage (in billable units) per resource key.

    ``basis='actual'`` bills CPU by measured core-hours; ``basis='request'``
    bills by requested core-hours (the "占着不用也算钱" policy).  Only the CPU
    key varies with basis — GPU/mem/storage have a single measured figure.

    Unknown/None totals values are treated as 0 so a partially-populated dict
    (e.g. an old series row) never raises.
    """
    totals = totals or {}
    out = {}
    for key, fields in RESOURCE_UNITS.items():
        field = fields[1] if (basis == "request" and len(fields) > 1) else fields[0]
        out[key] = float(_dec(totals.get(field) or 0))
    return out


def unit_price(prices, key):
    """Price in cents per unit for ``key`` (missing/None → 0)."""
    return _dec((prices or {}).get(key) or 0)


def cost_cents(totals, prices, basis="actual", keys=None):
    """Integer cents owed for ``totals`` at ``prices``, per resource key.

    Returns ``{resource_key: cents, "total_cents": cents}``.  Each key is
    rounded half-up independently; ``total_cents`` is the sum of the rounded
    per-key values (not a separate rounding), so per-key charges always add up
    to the total — the ledger sums per-key rows.
    """
    units = units_for(totals, basis)
    out = {}
    total = 0
    for key in (keys or RESOURCE_KEYS):
        cents = int((_dec(units.get(key)) * unit_price(prices, key)).quantize(_CENT, ROUND_HALF_UP))
        out[key] = cents
        total += cents
    out["total_cents"] = total
    return out


def breakdown(totals, prices, basis="actual"):
    """Per-key rows for display / the ledger: units, price, cost."""
    units = units_for(totals, basis)
    rows = []
    for key in RESOURCE_KEYS:
        price = unit_price(prices, key)
        cents = int((_dec(units[key]) * price).quantize(_CENT, ROUND_HALF_UP))
        rows.append({
            "resource_key": key,
            "label": RESOURCE_LABELS.get(key, key),
            "units": round(units[key], 4),
            "unit_price_cents": float(price),
            "cost_cents": cents,
        })
    return rows
