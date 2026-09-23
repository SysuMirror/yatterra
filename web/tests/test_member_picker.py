"""Isolated member-picker tests: never load app.py or production state/DB."""
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

class MemberPickerTests(unittest.TestCase):
    def setUp(self):
        self.modules = patch.dict(sys.modules)
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.users = load('picker_users', 'users.py')
        sys.modules['users'] = self.users
        self.groups = load('picker_groups', 'groups.py')
        sys.modules['groups'] = self.groups
        self.state = {'groups': {'demo': {'owners': ['owner'], 'members': ['member'], 'pending': [{'username': 'pending'}]}}}
        for obj, attr, kwargs in [
            (self.groups, 'load_state', {'return_value': self.state}),
            (self.groups, 'save_state', {}),
            (self.groups.audit, 'record', {}),
            (self.users, '_ensure_init', {}),
            (self.users, '_conn', {'side_effect': AssertionError('unexpected DB connection')}),
        ]:
            p = patch.object(obj, attr, **kwargs); p.start(); self.addCleanup(p.stop)

    def test_literal_prefix_and_pre_limit_exclusion(self):
        cn = MagicMock(); cur = cn.__enter__.return_value.cursor.return_value.__enter__.return_value
        cur.fetchall.return_value = [{'username': 'a_%!', 'role': 'hidden'}]
        with patch.object(self.users, '_conn', return_value=cn):
            self.assertEqual(self.users.search_users_prefix('a_%!', 999, ['owner', 'member']), [{'username': 'a_%!'}])
        sql, params = cur.execute.call_args.args
        self.assertIn("ESCAPE '!'", sql)
        self.assertLess(sql.index('NOT IN'), sql.index('LIMIT'))
        self.assertEqual(params, ('a!_!%!!%', 'member', 'owner', 20))

    def test_empty_overlong_non_string_do_not_query(self):
        for q in ['', ' ', 'x' * 65, None, 42, {}]:
            self.assertEqual(self.users.search_users_prefix(q), [])

    def test_mutations_validate_and_use_canonical_username(self):
        for method in [self.groups.invite_member, self.groups.add_owner]:
            for value in [None, {}, [], 42, '', 'x' * 65]:
                with self.assertRaises(ValueError): method('demo', value)
        with patch.object(self.users, 'get_user', return_value=None):
            with self.assertRaises(ValueError): self.groups.invite_member('demo', 'missing')
        self.groups.save_state.assert_not_called()
        with patch.object(self.users, 'get_user', return_value={'username': 'Canonical'}):
            self.groups.invite_member('demo', ' canonical ')
        self.assertIn('Canonical', self.state['groups']['demo']['members'])
        with patch.object(self.users, 'get_user', return_value={'username': 'member'}):
            self.groups.add_owner('demo', 'MEMBER')
        self.assertIn('member', self.state['groups']['demo']['owners'])
        self.assertNotIn('member', self.state['groups']['demo']['members'])

    def endpoint(self):
        from flask import Flask, request
        api = types.ModuleType('api'); api.__path__ = [str(ROOT / 'api')]
        api._body = lambda: request.get_json(silent=True) or {}
        sys.modules['api'] = api; sys.modules.pop('api._auth', None)
        for name in ['lifecycle', 'deploys', 'minio_svc', 'db_svc', 'cpu_stats', 'gpu_stats', 'metrics']:
            sys.modules[name] = types.ModuleType(name)
        from api import _auth
        pods = load('picker_pods', 'api/pods.py')
        app = Flask(__name__); app.secret_key = 'test'; app.register_blueprint(pods.pods_bp)
        return app.test_client(), _auth

    def test_endpoint_auth_modes_and_limits(self):
        client, auth = self.endpoint()
        path = '/api/pods/demo/members/candidates'
        with patch.object(self.users, 'search_users_prefix', return_value=[{'username': 'match'}]) as search:
            self.assertEqual(client.get(path+'?q=m').status_code, 401)
            with patch.object(auth, '_resolve_user', return_value={'username': 'stranger', 'role': 'user'}):
                self.assertEqual(client.get(path+'?q=m').status_code, 403)
            search.assert_not_called()
            with patch.object(auth, '_resolve_user', return_value={'username': 'owner', 'role': 'user'}):
                self.assertEqual(client.get(path+'?q=m').json, {'items': [{'username': 'match'}]})
                search.assert_called_with('m', limit=10, excluded={'owner', 'member', 'pending'})
                self.assertEqual(client.get(path+'?q=m&mode=owner&limit=999').status_code, 200)
                search.assert_called_with('m', limit=20, excluded={'owner'})
                self.assertEqual(client.get(path+'?q=m&mode=bad').status_code, 400)
                self.assertEqual(client.get(path+'?q='+('x'*65)).status_code, 400)
                self.assertEqual(client.get(path).json, {'items': []})
                self.assertEqual(client.get('/api/pods/missing/members/candidates?q=m').status_code, 404)
                for endpoint in ['members/invite', 'owners/add']:
                    self.assertEqual(client.post('/api/pods/demo/'+endpoint, json={'username': {'bad': 1}}).status_code, 400)

if __name__ == '__main__': unittest.main()
