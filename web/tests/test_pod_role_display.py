"""Displayed vs effective Pod role for super/admin.

``users.pod_role`` keeps granting super/admin owner-level access to **every**
pod (that is what the permission guards use).  The UI must not advertise that
implicit ownership, so the API also exposes:

* ``my_role_explicit``  — real owners/members membership only (None otherwise)
* ``my_role_for_display`` — explicit role, else 管理员, else 负责人 when the pod
  has no explicit owner at all (the admin is then its only owner)

Also pins the pagination cap: admins viewing "all pods" must not be truncated at
the old 50/100 ceiling.
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from flask import Flask, request

import api._auth as auth_mod
import api.pods as pods_api
import groups
import users

PODS = {
    "mine": {"name": "mine", "owners": ["mony"], "members": ["alice"]},
    "theirs": {"name": "theirs", "owners": ["bob"], "members": []},
    "orphan": {"name": "orphan", "owners": [], "members": []},
    "paired": {"name": "paired", "owners": ["bob", "mony"], "members": []},
}

SUPER = {"username": "mony", "role": "super"}
ADMIN = {"username": "ops", "role": "admin"}
PLAIN = {"username": "alice", "role": "user"}       # member of "mine"
OUTSIDER = {"username": "eve", "role": "user"}


class RoleDisplay(unittest.TestCase):
    # ── effective role is unchanged (permission gating) ──────────────
    def test_effective_role_still_owner_for_admins(self):
        for u in (SUPER, ADMIN):
            self.assertEqual(users.pod_role(u, PODS["theirs"]), "owner")
            self.assertTrue(users.can_pod(u, PODS["orphan"], "owner"))

    def test_effective_role_for_plain_users(self):
        self.assertEqual(users.pod_role(PLAIN, PODS["mine"]), "member")
        self.assertEqual(users.pod_role(PLAIN, PODS["theirs"]), None)

    # ── explicit membership ─────────────────────────────────────────
    def test_explicit_ignores_admin_override(self):
        self.assertIsNone(users.pod_role_explicit(SUPER, PODS["theirs"]))
        self.assertIsNone(users.pod_role_explicit(ADMIN, PODS["orphan"]))
        self.assertEqual(users.pod_role_explicit(SUPER, PODS["mine"]), "owner")
        self.assertEqual(users.pod_role_explicit(SUPER, PODS["paired"]), "owner")
        self.assertEqual(users.pod_role_explicit(PLAIN, PODS["mine"]), "member")
        self.assertIsNone(users.pod_role_explicit(OUTSIDER, PODS["mine"]))
        self.assertIsNone(users.pod_role_explicit(None, PODS["mine"]))

    # ── displayed role ──────────────────────────────────────────────
    def test_display_role_hides_implicit_ownership(self):
        self.assertEqual(users.pod_display_role(SUPER, PODS["theirs"]), "super")
        self.assertEqual(users.pod_display_role(ADMIN, PODS["theirs"]), "admin")

    def test_display_role_is_owner_when_sole_owner(self):
        # empty owners list → the admin is the pod's only effective owner
        self.assertEqual(users.pod_display_role(SUPER, PODS["orphan"]), "owner")
        self.assertEqual(users.pod_display_role(ADMIN, PODS["orphan"]), "owner")

    def test_display_role_prefers_explicit_membership(self):
        self.assertEqual(users.pod_display_role(SUPER, PODS["mine"]), "owner")
        self.assertEqual(users.pod_display_role(ADMIN, PODS["paired"]), "admin")
        self.assertEqual(users.pod_display_role(PLAIN, PODS["mine"]), "member")
        self.assertIsNone(users.pod_display_role(OUTSIDER, PODS["mine"]))


def resolve_user():
    name = request.headers.get("X-Test-User")
    for u in (SUPER, ADMIN, PLAIN, OUTSIDER):
        if u["username"] == name:
            return dict(u)
    return None


class ListPods(unittest.TestCase):
    """The list endpoint: all pods for admins + the two new role fields."""

    def setUp(self):
        for p in (
            mock.patch.object(auth_mod, "_resolve_user", resolve_user),
            mock.patch.object(groups, "load_state", lambda: {"groups": PODS}),
            mock.patch.object(groups, "pod_status", lambda name: "Running"),
            mock.patch.object(pods_api, "nodes",
                              mock.MagicMock(node_for=lambda pod: None, DEFAULT_NODE="wz8")),
            mock.patch.object(users, "user_labels", lambda names: {}),
        ):
            p.start()
            self.addCleanup(p.stop)
        app = Flask(__name__)
        app.register_blueprint(pods_api.pods_bp, url_prefix="/pods")
        app.config["TESTING"] = True
        self.c = app.test_client()

    def fetch(self, user, qs=""):
        r = self.c.get(f"/pods/{qs}", headers={"X-Test-User": user})
        self.assertEqual(r.status_code, 200)
        return r.get_json()

    def test_super_sees_every_pod(self):
        body = self.fetch("mony", "?per_page=200")
        self.assertEqual(body["total"], len(PODS))
        self.assertEqual(len(body["pods"]), len(PODS))   # nothing truncated
        self.assertEqual(body["per_page"], 200)          # cap raised above 100

    def test_fields_separate_effective_from_displayed(self):
        by = {p["name"]: p for p in self.fetch("mony", "?per_page=200")["pods"]}
        self.assertEqual(by["theirs"]["my_role"], "owner")            # gating
        self.assertIsNone(by["theirs"]["my_role_explicit"])          # not displayed
        self.assertEqual(by["theirs"]["my_role_for_display"], "super")
        self.assertEqual(by["mine"]["my_role_for_display"], "owner")  # explicit owner
        self.assertEqual(by["orphan"]["my_role_for_display"], "owner")  # sole owner

    def test_admin_display_is_admin_not_owner(self):
        by = {p["name"]: p for p in self.fetch("ops", "?per_page=200")["pods"]}
        self.assertEqual(by["theirs"]["my_role_for_display"], "admin")
        self.assertEqual(by["mine"]["my_role_for_display"], "admin")

    def test_plain_user_still_scoped(self):
        body = self.fetch("alice")
        self.assertEqual([p["name"] for p in body["pods"]], ["mine"])
        self.assertEqual(body["pods"][0]["my_role_for_display"], "member")
        self.assertEqual(body["pods"][0]["my_role_explicit"], "member")


if __name__ == "__main__":
    unittest.main()
