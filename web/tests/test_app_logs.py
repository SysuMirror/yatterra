"""Isolated app-log endpoint tests; no app startup, pods, or production reads."""
import importlib.util, json, sys, types, unittest
from pathlib import Path
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

class AppLogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mods = patch.dict(sys.modules); cls.mods.start(); cls.addClassCleanup(cls.mods.stop)
        for name in ('siteconf','users','groups','lifecycle','audit','deploys','minio_svc','db_svc','cpu_stats','gpu_stats','metrics'):
            m = types.ModuleType(name); sys.modules[name] = m
        sys.modules['groups'].NS = 'test'
        sys.modules['groups'].load_state = lambda: {'groups': {}}
        sys.modules['users'].can_pod = lambda *args: True
        sys.modules['deploys'].resolve_pod = lambda name: 'pod'
        sys.modules['deploys']._exec = lambda *args, **kwargs: (0, '', '')
        api = types.ModuleType('api'); api.__path__ = [str(ROOT / 'api')]; api._body = lambda: {}
        sys.modules['api'] = api; sys.modules.pop('api._auth', None)
        from api import _auth
        cls.auth = _auth
        cls.pods = load('app_logs_pods', 'api/pods.py')
        cls.client_app = __import__('flask').Flask(__name__); cls.client_app.secret_key = 'test'; cls.client_app.register_blueprint(cls.pods.pods_bp)

    def client(self):
        from flask import g
        def user(*args, **kwargs):
            g.api_user = {'username': 'member'}; g.api_pod = {'members': ['member']}
            return kwargs.get('_fn')(*args) if False else None
        return self.client_app.test_client()

    def request(self, query='', result=(0, '', '')):
        with patch.object(self.auth, '_resolve_user', return_value={'username': 'member'}), \
             patch.object(self.pods.groups, 'load_state', return_value={'groups': {'demo': {'members': ['member']}}}), \
             patch.object(self.pods.users, 'can_pod', return_value=True), \
             patch.object(self.pods.deploys, 'resolve_pod', return_value='pod'), \
             patch.object(self.pods.deploys, '_exec', return_value=result):
            return self.client().get('/api/pods/demo/app-logs' + query)

    def test_structured_list_preserves_alias_and_spaces(self):
        data = {'files': [{'name': 'app.log', 'size': 1, 'mtime': 2, 'symlink': False}, {'name': 'worker one.log', 'size': 3, 'mtime': 4, 'symlink': True, 'source': '/home/cloud/logs/worker one.log'}]}
        response = self.request(result=(0, json.dumps(data), ''))
        self.assertEqual(response.status_code, 200); self.assertEqual(response.json, data)

    def test_text_empty_is_success_and_read_error_is_not_empty(self):
        self.assertEqual(self.request('?file=app.log', result=(0, '', '')).status_code, 200)
        self.assertEqual(self.request('?file=missing.log', result=(3, '', 'log file not found')).status_code, 404)
        self.assertEqual(self.request('?file=app.log', result=(1, '', 'permission denied')).status_code, 502)

    def test_filename_escaping_and_tail_bounds(self):
        for value in ('../app.log', 'x/y.log', 'x\\y.log', 'bad.txt'):
            self.assertEqual(self.request('?file=' + value).status_code, 400)
        for value in ('0', '2001', '-1', 'nope'):
            self.assertEqual(self.request('?file=app.log&tail=' + value).status_code, 400)
        self.assertEqual(self.request('?file=app.log&tail=2000', result=(0, 'ok', '')).status_code, 200)

if __name__ == '__main__': unittest.main()
