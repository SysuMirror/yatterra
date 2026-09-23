"""Focused tutorial contracts and executable standard-library sample tests."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
NODE = r'''
const fs = require('fs'), p = require('@babel/parser');
const src=fs.readFileSync('src/components/docs/LearningPath.tsx','utf8');
const ast=p.parse(src,{sourceType:'module',plugins:['typescript','jsx']});
const out={lessons:[],sections:[]};
function walk(n){ if(!n||typeof n!=='object')return;
 if(n.type==='VariableDeclarator'&&['APP','DEPLOY'].includes(n.id.name)) out[n.id.name]=n.init.quasis[0].value.cooked;
 if(n.type==='CallExpression'&&n.callee.name==='L') out.lessons.push(n.arguments.map(x=>x.type==='StringLiteral'?x.value:x.type==='ArrayExpression'?x.elements.map(y=>y.value):null));
 for(const v of Object.values(n)){if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v);}
} walk(ast);
const docs=p.parse(fs.readFileSync('src/routes/docs.tsx','utf8'),{sourceType:'module',plugins:['typescript','jsx']});
function find(n){if(!n||typeof n!=='object')return;
 if(n.type==='VariableDeclarator'&&n.id.name==='sections') out.sections=n.init.elements.map(s=>{const prop=k=>s.properties.find(x=>x.key.name===k)?.value;return [prop('id').value,prop('items').elements.map(i=>i.properties.find(x=>x.key.name==='title').value.value)];});
 for(const v of Object.values(n)){if(Array.isArray(v))v.forEach(find);else if(v&&typeof v==='object')find(v);}
} find(docs); console.log(JSON.stringify(out));
'''

class LessonsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data=json.loads(subprocess.check_output(['node','-e',NODE],cwd=ROOT,text=True))

    def test_stable_complete_lesson_order(self):
        expected='concepts pod connect first-app environment logs deploy recovery webhook access services collaboration troubleshooting'.split()
        self.assertEqual([x[0] for x in self.data['lessons']],expected)
        for lesson in self.data['lessons']:
            for value in lesson[:7]: self.assertTrue(value)

    def test_legacy_deep_link_indices(self):
        sections=dict(self.data['sections'])
        self.assertEqual(sections['pods'][4],'新手部署步骤')
        self.assertEqual(sections['quickstart'],['登录','创建 Pod','连接 Pod'])
        self.assertIn('ops-knowledge',sections)
        self.assertIn('ai-kb',sections)

    def test_safety_contracts(self):
        text=(ROOT/'src/components/docs/LearningPath.tsx').read_text()
        for term in ['rollout','重新运行 Deploy','last_good_ref','autostart','精确一致','source=github','source=gitee','window.location.origin','navigator.clipboard.writeText','canViewStaffDocs']:
            self.assertIn(term,text)
        self.assertIn('exec python3 app.py',self.data['DEPLOY'])
        self.assertNotIn('nohup',self.data['DEPLOY'])
        self.assertNotIn('pip install',self.data['DEPLOY'])

    def test_sample_application_runs_without_dependencies(self):
        with tempfile.TemporaryDirectory() as d:
            app=Path(d)/'app.py'; app.write_text(self.data['APP'])
            with socket.socket() as sock:
                sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
            env={**os.environ,'PORT':str(port),'APP_GREETING':'lesson-test','LOG_DIR':str(Path(d)/'logs')}
            process=subprocess.Popen(['python3',str(app)],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            try:
                opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
                for attempt in range(50):
                    try:
                        with opener.open(f'http://127.0.0.1:{port}/health',timeout=1) as response:
                            self.assertEqual(json.load(response),{'ok':True})
                        break
                    except OSError:
                        if attempt==49: raise
                        time.sleep(.05)
                with opener.open(f'http://127.0.0.1:{port}/',timeout=1) as response:
                    self.assertEqual(json.load(response),{'message':'lesson-test'})
                self.assertIn('GET /health',(Path(d)/'logs/app.log').read_text())
            finally:
                process.terminate(); process.wait(timeout=5)

if __name__=='__main__': unittest.main()
