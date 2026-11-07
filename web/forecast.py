#!/usr/bin/env python3
"""Load forecasting for the valley/peak scheduler — pure stdlib STL-lite.

The reactive control stack knows only *now*; the valley-shifting scheduler
(P1-c) needs a forecast of demand per future hour slot.  This module produces
one from the P0-b feature table (falling back to the metering table).

No numpy/statsmodels on the platform interpreter, so real STL is unavailable:
``stl_decompose`` implements the classic additive decomposition (centred moving
average trend + hour-of-day seasonal + residual) with an optional Hampel
robustification — same signature as a real STL, so it can be swapped later.

Period is **24h only** (the ~10-day history cannot identify a weekly cycle).

Predicted quantity is **demand/load** (usage), not free supply — the scheduler
subtracts it from capacity (P1-c's ``S_t``).

Degradation ladder: none -> flat -> climatology -> seasonal, down-shifted when
history is stale; a dead all-zero column (e.g. pre-P0-a gpu compute) is refused
rather than modelled as flat-zero.

Single writer of ``timeline.json`` (via ``timeline.write``) and of
``forecast_state.json`` (EWMA correction state).  Never raises out of the public
functions.  Hosted inline by ``req_loop`` (no daemon of its own).
"""
import json
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import siteconf  # noqa: E402
import timeline  # noqa: E402

PERIOD_H = 24               # only cycle the history can identify
STALE_H = 3                 # last bucket older than this -> downgrade
HISTORY_D = 30              # how far back to read
PUBLISH_S = 600             # min seconds between timeline.json publishes
MIN_FLAT = 6                # fewer than this -> refuse to model
DEAD_EPS = 1e-9             # all-zero column detector
# The in-sample p80 residual band understates 24h-ahead error (the level drifts
# over the horizon); inflating it restores ~80% empirical coverage.  Applied to
# the seasonal band only — flat/climatology already spread over the level.
BAND_INFLATE = 1.75

STATE_FILE = os.environ.get("YATTERRA_FORECAST_STATE", siteconf.path("forecast_state.json"))

# metric -> (integral column, scale to a per-hour rate)
METRIC_COLS = {
    "cpu": ("cpu_core_seconds", 1.0 / 3600),
    "mem": ("mem_gib_seconds", 1.0 / 3600),
    "gpu": ("gpu_compute_card_seconds", 1.0 / 3600),
    "gpu_mem": ("gpu_mem_gib_seconds", 1.0 / 3600),
}

# z-scores for p10/p90 of a normal residual
_Z10, _Z90 = -1.2816, 1.2816


# ── small stats helpers ─────────────────────────────────────────
def _mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else 0.0


def _stdev(xs):
    xs = [x for x in xs if x is not None]
    if len(xs) < 2:
        return 0.0
    m = _mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def _quantile(sorted_xs, q):
    """Linear-interpolation quantile of a pre-sorted list."""
    if not sorted_xs:
        return None
    if len(sorted_xs) == 1:
        return float(sorted_xs[0])
    pos = q * (len(sorted_xs) - 1)
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(sorted_xs) - 1)
    frac = pos - lo
    return sorted_xs[lo] * (1 - frac) + sorted_xs[hi] * frac


def _median(xs):
    return _quantile(sorted(xs), 0.5) if xs else 0.0


# ── series loading ──────────────────────────────────────────────
def _store_rows(group, since, until, bucket):
    """Yield each store's rows in preference order (feature table first).

    The feature table can be legitimately empty *or* hold only a still-partial
    current bucket while its hourly rollups warm up; the metering table carries
    a longer history.  Callers apply the partial-bucket filter and take the
    first store that yields usable rows.
    """
    for modname in ("feature_store", "usage_store"):
        try:
            mod = __import__(modname)
            cls = getattr(mod, "FeatureStore", None) or getattr(mod, "UsageStore")
            st = cls()
            rows = (st.series(group, since, until, bucket) if group
                    else st.summary(since, until, bucket)[0])
            yield rows or []
        except Exception:
            yield []


def load_series(group, metric="cpu", bucket="hour"):
    """Time-ordered ``[{ts, value}]`` for a metric; ``value`` is a per-hour rate.

    Drops a trailing partial bucket.  Empty list on any failure or unknown metric.
    """
    col_scale = METRIC_COLS.get(metric)
    if not col_scale:
        return []
    col, scale = col_scale
    now = time.time()
    since = int(now - HISTORY_D * 86400)
    span = 86400 if bucket == "day" else 3600
    for rows in _store_rows(group, since + span, int(now), bucket):
        out = []
        for r in rows:
            ts = r.get("bucket_start")
            if ts is None:
                continue
            if ts + span > now:      # partial current bucket
                continue
            out.append({"ts": int(ts), "value": float(r.get(col) or 0) * scale})
        if out:
            out.sort(key=lambda x: x["ts"])
            return out
    return []


# ── STL-lite ────────────────────────────────────────────────────
def _hampel(xs, k=3):
    """Replace point outliers (|x-med| > k*1.4826*MAD) with the local median."""
    n = len(xs)
    if n < 5:
        return list(xs)
    out = list(xs)
    for i in range(n):
        lo, hi = max(0, i - 3), min(n, i + 4)
        win = xs[lo:hi]
        med = _median(win)
        mad = _median([abs(x - med) for x in win]) or 0.0
        # MAD is 0 whenever a majority of the window sits on the median (e.g. a
        # lone spike in a flat background); fall back to mean abs deviation so
        # the spike is still flagged.
        scale = 1.4826 * mad if mad > 0 else _mean([abs(x - med) for x in win])
        if scale > 0 and abs(xs[i] - med) > k * scale:
            out[i] = med
    return out


def _moving_average(xs, window):
    """Centred moving average; window shrinks at the edges (never empty)."""
    n = len(xs)
    half = max(1, window // 2)
    out = []
    for i in range(n):
        lo, hi = max(0, i - half), min(n, i + half + 1)
        out.append(_mean(xs[lo:hi]))
    return out


def _tail_level(trend):
    """Robust current level: mean of the last full day of trend.

    The very last trend point sits in a shrunk edge window and is biased; a
    day-long mean of the trend is local but far less noisy.
    """
    if not trend:
        return 0.0
    return _mean(trend[-PERIOD_H:])


def stl_decompose(values, period=PERIOD_H, robust=True):
    """Classic additive decomposition → ``(trend, seasonal, resid)``.

    Returns three lists the same length as ``values``.  ``robust`` runs a Hampel
    pass first so spikes don't distort the seasonal profile.
    """
    xs = [float(v or 0.0) for v in values]
    n = len(xs)
    if n == 0:
        return [], [], []
    src = _hampel(xs) if robust else xs
    trend = _moving_average(src, period if n >= period else max(1, n // 2))
    detrended = [src[i] - trend[i] for i in range(n)]
    # seasonal profile = per-phase mean of detrended, centred to zero mean
    acc, cnt = {}, {}
    for i in range(n):
        s = i % period
        acc[s] = acc.get(s, 0.0) + detrended[i]
        cnt[s] = cnt.get(s, 0) + 1
    prof = {s: acc[s] / cnt[s] for s in acc}
    pm = _mean(list(prof.values()))
    prof = {s: v - pm for s, v in prof.items()}
    seasonal = [prof.get(i % period, 0.0) for i in range(n)]
    resid = [xs[i] - trend[i] - seasonal[i] for i in range(n)]
    return trend, seasonal, resid


# ── state (EWMA correction) ─────────────────────────────────────
def _state_key(group, metric):
    return f"{group or '_platform'}|{metric}"


def load_state():
    try:
        with open(STATE_FILE) as f:
            obj = json.load(f)
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def save_state(state):
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        tmp = STATE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(state, f, ensure_ascii=False)
        try:
            os.chmod(tmp, 0o640)
        except OSError:
            pass
        os.replace(tmp, STATE_FILE)
    except Exception:
        pass


def _series_state(state, group, metric):
    return state.setdefault("series", {}).setdefault(
        _state_key(group, metric),
        {"bias_ewma": 0.0, "abs_err": [], "last_pred": {}, "updated_at": 0})


# ── prediction ──────────────────────────────────────────────────
def _confidence(n, stale):
    if stale:
        return "low"
    if n >= 2 * PERIOD_H:
        return "high" if n >= 4 * PERIOD_H else "med"
    if n >= PERIOD_H:
        return "low"
    return "low"


def predict_supply(group=None, horizon=24, metric="cpu", now=None):
    """Forecast demand for the next ``horizon`` hourly slots.  Never raises."""
    now = float(now if now is not None else time.time())
    rows = load_series(group, metric, bucket="hour")
    values = [r["value"] for r in rows]
    n = len(values)
    stale = bool(rows) and (now - rows[-1]["ts"]) > STALE_H * 3600
    result = {"group": group, "metric": metric, "horizon_h": horizon,
              "generated_at": now, "history_hours": n, "stale": stale,
              "confidence": _confidence(n, stale), "kind": "none", "slots": []}
    if n == 0:
        return result
    if max(values) <= DEAD_EPS:      # dead column: refuse to model flat-zero
        result["kind"] = "none"
        result["note"] = "dead-column"
        return result

    state = load_state()
    ss = _series_state(state, group, metric)
    bias = float(ss.get("bias_ewma") or 0.0)

    if n < MIN_FLAT:
        kind = "none"
    elif n < PERIOD_H:
        kind = "flat"
    elif n < 2 * PERIOD_H:
        kind = "climatology"
    else:
        kind = "seasonal"
    result["kind"] = kind

    if kind == "none":
        return result

    trend = seasonal = resid = None
    if kind == "seasonal":
        trend, seasonal, resid = stl_decompose(values)
        band = (_quantile(sorted(abs(x) for x in resid), 0.8) or 0.0) * BAND_INFLATE
        base_level = _tail_level(trend)
    elif kind == "climatology":
        base_level = _mean(values)
        band = _stdev(values)
    else:  # flat
        base_level = _mean(values)
        band = _stdev(values)

    # per-phase climatology means (for 'climatology')
    by_hod = {}
    for i, v in enumerate(values):
        by_hod.setdefault(i % PERIOD_H, []).append(v)

    base_slot = int(math.ceil(now / 3600.0) * 3600)
    slots = []
    for k in range(horizon):
        t = base_slot + k * 3600
        hod = (t // 3600) % PERIOD_H
        if kind == "seasonal":
            mu = base_level + (seasonal[hod] if seasonal else 0.0)
            obs = [values[i] for i in range(n) if i % PERIOD_H == hod]
        elif kind == "climatology":
            obs = by_hod.get(hod) or values
            mu = _mean(obs)
        else:
            obs = values
            mu = base_level
        mu += bias
        p10 = max(0.0, mu + _Z10 * band)
        p90 = max(0.0, mu + _Z90 * band)
        slots.append({
            "slot_start": t, "hour_of_day": hod, "hour_local": (hod + 8) % PERIOD_H,
            "mean": round(mu, 4), "p10": round(min(p10, mu), 4),
            "p50": round(mu, 4), "p90": round(max(p90, mu), 4),
            "n_obs": len(obs), "kind": kind,
        })
    result["slots"] = slots
    result["valley_windows"] = valley_windows(result)
    ss["last_pred"] = {str(s["slot_start"]): s["mean"] for s in slots}
    ss["updated_at"] = int(now)
    save_state(state)
    return result


def valley_windows(result, frac=0.33, max_windows=3):
    """Contiguous low-p50 windows (p50 <= min + frac*(max-min)), longest first."""
    slots = (result or {}).get("slots") or []
    if len(slots) < 2:
        return []
    p50 = [s["p50"] for s in slots]
    lo, hi = min(p50), max(p50)
    if hi - lo <= DEAD_EPS:
        return []
    thr = lo + frac * (hi - lo)
    windows, cur = [], None
    for s in slots:
        if s["p50"] <= thr:
            if cur is None:
                cur = {"start": s["slot_start"], "end": s["slot_start"] + 3600,
                       "p50s": [s["p50"]]}
            else:
                cur["end"] = s["slot_start"] + 3600
                cur["p50s"].append(s["p50"])
        else:
            if cur:
                windows.append(cur)
                cur = None
    if cur:
        windows.append(cur)
    out = [{"start": w["start"], "end": w["end"], "n_slots": len(w["p50s"]),
            "mean_p50": round(_mean(w["p50s"]), 4),
            "confidence": (result.get("confidence") or "low")}
           for w in windows]
    out.sort(key=lambda w: (-w["n_slots"], w["mean_p50"]))
    return out[:max_windows]


def update_correction(group, metric, observed, slot_start, now=None):
    """Fold an observed value back into the EWMA bias for ``(group, metric)``."""
    now = float(now if now is not None else time.time())
    state = load_state()
    ss = _series_state(state, group, metric)
    pred = (ss.get("last_pred") or {}).get(str(int(slot_start)))
    resid = None
    if pred is not None:
        resid = float(observed) - float(pred)
        ss["bias_ewma"] = round(0.9 * float(ss.get("bias_ewma") or 0.0) + 0.1 * resid, 6)
        errs = list(ss.get("abs_err") or [])
        errs.append(abs(resid))
        ss["abs_err"] = errs[-240:]
    ss["updated_at"] = int(now)
    save_state(state)
    return {"resid": resid, "bias_ewma": ss.get("bias_ewma")}


def observe(group=None, metric="cpu", now=None):
    """Close the loop: fold the most recent completed hour into the EWMA bias.

    Finds the newest finished bucket in the series and corrects against the
    prediction stored for that slot (if any).  Used by ``tick`` so the host loop
    needs only one call.  Never raises.
    """
    now = float(now if now is not None else time.time())
    try:
        rows = load_series(group, metric)
        if not rows:
            return None
        last = rows[-1]
        return update_correction(group, metric, last["value"], last["ts"], now)
    except Exception:
        return None


def error_quantile(metric, eps=0.8):
    """Empirical |error| quantile for a metric (pools all groups); None if cold."""
    state = load_state()
    errs = []
    for key, ss in (state.get("series") or {}).items():
        if key.rsplit("|", 1)[-1] == metric:
            errs.extend(ss.get("abs_err") or [])
    return _quantile(sorted(errs), eps) if errs else None


def age_s(now=None):
    """Seconds since the last publish/correction touch (staleness for P1-c)."""
    now = float(now if now is not None else time.time())
    ts = (load_state() or {}).get("published_ts")
    return None if not ts else round(now - float(ts), 1)


def supply(dim, horizon_bins, delta_s, group=None):
    """P1-c compatibility shim → per-bin supply rows from ``predict_supply``."""
    res = predict_supply(group=group, horizon=len(range(horizon_bins)),
                         metric=dim)
    step = max(1, int(delta_s))
    return [{"bin_start": s["slot_start"], "delta_s": step, "mean": s["mean"],
             "p10": s["p10"], "p50": s["p50"], "p90": s["p90"], "kind": s["kind"]}
            for s in res.get("slots", [])]


# ── supply ledger (P1-c prerequisite, closes U1/C3) ─────────────
def capacity(now=None):
    """Host GPU capacity + occupancy ledger, for the defer queue's supply S_t.

    Per card: total/used/free MiB (from ``nvidia-smi`` via ``scheduler``) plus
    committed train VRAM (from ``gpu_alloc.json``).  Future *free* VRAM is not
    modelled — the deferred trains are themselves the future consumers, and
    other consumers are unknowable — so S_t = today's free free VRAM and the
    forecast supplies only the *timing* (schedule at the valley).  Never raises.
    """
    now = float(now if now is not None else time.time())
    out = {"generated_at": now, "source": "unavailable", "cards": [],
           "free_total_mib": 0, "committed_total_mib": 0}
    try:
        import scheduler
        sm = scheduler.sample()
    except Exception:
        sm = []
    if not sm:
        return out
    try:
        alloc = scheduler.all_deploys() or {}
    except Exception:
        alloc = {}
    committed = {}
    for rec in alloc.values():
        gpu = rec.get("gpu")
        if gpu is None or (rec.get("status") or "") not in (
                "running", "queued", "deferred"):
            continue
        try:
            committed[gpu] = committed.get(gpu, 0) + int(rec.get("vram") or 0)
        except (TypeError, ValueError):
            continue
    for g in sm:
        try:
            idx = int(g["index"])
            used = int(g.get("vram_used") or 0)
            free = int(g.get("vram_free") or 0)
        except (TypeError, ValueError, KeyError):
            continue
        out["cards"].append({"index": idx, "total_mib": used + free,
                             "used_mib": used, "free_mib": free,
                             "committed_mib": committed.get(idx, 0)})
    if out["cards"]:
        out["source"] = "nvidia-smi"
        out["free_total_mib"] = sum(c["free_mib"] for c in out["cards"])
        out["committed_total_mib"] = sum(c["committed_mib"] for c in out["cards"])
    return out


def free_mib(group=None, now=None):
    """Best single-card free VRAM (MiB) among a group's allowed GPUs.

    The admission question is "does *one* card fit d_j"; returns the largest
    free on any allowed card, or ``None`` when capacity is unavailable (callers
    treat None as "degrade to reactive").
    """
    cap = capacity(now)
    if not cap.get("cards"):
        return None
    try:
        import scheduler
        allowed = scheduler._group_gpus(group) if group else None
    except Exception:
        allowed = None
    best = 0
    for c in cap["cards"]:
        if allowed is not None and c["index"] not in allowed:
            continue
        best = max(best, c["free_mib"])
    return best


# ── publishing (single writer of timeline.json) ─────────────────
def snapshot(now=None):
    """Compute the phase + valley window and publish ``timeline.json``."""
    now = float(now if now is not None else time.time())
    res = predict_supply(group=None, horizon=PERIOD_H, metric="cpu", now=now)
    slots = res.get("slots") or []
    wins = valley_windows(res) if slots else []
    nv = wins[0] if wins else {}
    # phase from where `now` sits in the forecast: bottom tercile -> valley
    phase = "shoulder"
    if slots:
        p50 = [s["p50"] for s in slots]
        lo, hi = min(p50), max(p50)
        if hi - lo > DEAD_EPS:
            cur = p50[0]
            if cur <= lo + 0.33 * (hi - lo):
                phase = "valley"
            elif cur >= hi - 0.33 * (hi - lo):
                phase = "peak"
        elif res.get("kind") == "none" and not res.get("slots"):
            phase = "shoulder"
    obj = {
        "schema": timeline.SCHEMA,
        "generated_ts": int(now),
        "horizon_s": PERIOD_H * 3600,
        "phase": phase,
        "confidence": res.get("confidence"),
        "stale": res.get("stale"),
        "next_valley": nv,
        "next_peak": {},
        "per_group": {},
    }
    published = timeline.write(obj)
    state = load_state()
    state["published_ts"] = int(now)
    state["phase"] = phase
    save_state(state)
    return published


def tick(now=None):
    """req_loop hook: publish at most every PUBLISH_S; cheap otherwise."""
    now = float(now if now is not None else time.time())
    last = (load_state() or {}).get("published_ts") or 0
    if now - float(last) < PUBLISH_S:
        return None
    try:
        observe(None, "cpu", now)     # fold last completed hour into the bias
        return snapshot(now)
    except Exception:
        return None


# ── backtest ────────────────────────────────────────────────────
def backtest(group=None, metric="cpu", holdout_h=24, folds=3):
    """Rolling-origin backtest: MAE + p10-p90 coverage over ``folds`` windows."""
    rows = load_series(group, metric, bucket="hour")
    values = [r["value"] for r in rows]
    n = len(values)
    if n < holdout_h + PERIOD_H:
        return {"folds": 0, "mae": None, "coverage": None, "samples": 0}
    maes, covered, total, done = [], 0, 0, 0
    for f in range(folds):
        cut = n - holdout_h * (f + 1)
        if cut < PERIOD_H:
            break
        train = values[:cut]
        test = values[cut:cut + holdout_h]
        trend, seasonal, resid = stl_decompose(train)
        band = (_quantile(sorted(abs(x) for x in resid), 0.8) or 0.0) * BAND_INFLATE
        level = _tail_level(trend)
        for j, y in enumerate(test):
            hod = (cut + j) % PERIOD_H
            mu = level + (seasonal[hod] if seasonal else 0.0)
            maes.append(abs(y - mu))
            if max(0.0, mu + _Z10 * band) <= y <= max(0.0, mu + _Z90 * band):
                covered += 1
            total += 1
        done += 1
    return {"folds": done, "mae": round(_mean(maes), 4) if maes else None,
            "coverage": round(covered / total, 4) if total else None,
            "samples": total}


if __name__ == "__main__":
    if "--backtest" in sys.argv[1:]:
        g = None
        if "--group" in sys.argv:
            g = sys.argv[sys.argv.index("--group") + 1]
        print(json.dumps(backtest(g), ensure_ascii=False, indent=2))
    else:
        print(json.dumps(snapshot(), ensure_ascii=False, indent=2))
