"""Threat Map API blueprint — /api/threat-map

Honeypot threat visualization data (requires ops.threat — all real users,
not guests; matches the frontend 攻防 page gating).
"""
import time, os, json
from flask import Blueprint, request, jsonify
from middleware.error_handler import bad_request

import siteconf

from api._auth import require_auth

threat_map_bp = Blueprint("api_threat_map", __name__, url_prefix="/api/threat-map")

# In-memory cache: window -> {ts, data}
_threat_cache = {}


@threat_map_bp.route("", methods=["GET"])
@require_auth("ops.threat")
def threat_map_data():
    """Get threat map data.

    Query params:
      window - time window: 1h, 3h, 1d, 3d, 7d, all (default: 3d)
    """
    w = request.args.get("window", "3d")
    if w not in ("1h", "3h", "1d", "3d", "7d", "all"):
        w = "3d"

    now = time.time()
    c = _threat_cache.get(w)
    if c and now - c["ts"] < 5 and c["data"]:
        return jsonify(c["data"])

    path = os.path.join(siteconf.HONEYPOT_DIR, f"feed_{w}.json")
    try:
        with open(path) as f:
            data = json.load(f)
        _threat_cache[w] = {"ts": now, "data": data}
        return jsonify(data)
    except Exception:
        return jsonify({
            "updated": "",
            "target": {},
            "attacks": [],
            "normal": [],
            "stats": {
                "total_attacks": 0,
                "total_normal": 0,
                "total_banned": 0,
                "total_conns": 0,
            },
        })
