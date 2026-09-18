import os, tempfile, unittest
from unittest.mock import patch
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pwa_alerts

class Alerts(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory(); self.db=os.path.join(self.t.name,'a.db')
  self.old=pwa_alerts.DB_PATH; pwa_alerts.DB_PATH=self.db; pwa_alerts.BAD_CONFIRMATIONS=2; pwa_alerts.init_db()
  self.sent=[]
  self.patch=patch.object(pwa_alerts,'_send',side_effect=lambda *a,**k:self.sent.append(a) or {'sent':1}); self.patch.start()
  self.state={'ok':True,'replicas':1,'readyReplicas':1,'phase':'Running'}
 def tearDown(self): self.patch.stop(); pwa_alerts.DB_PATH=self.old; self.t.cleanup()
 def test_startup_bad_quiet_then_edge_and_recovery(self):
  bad={'ok':True,'replicas':1,'readyReplicas':0,'phase':'CrashLoopBackOff'}
  self.assertFalse(pwa_alerts.observe_group('x',bad)); self.assertFalse(pwa_alerts.observe_group('x',bad)); self.assertEqual(len(self.sent),0)
  pwa_alerts.observe_group('x',self.state); pwa_alerts.observe_group('x',bad); self.assertFalse(self.sent)
  self.assertTrue(pwa_alerts.observe_group('x',bad)); self.assertEqual(len(self.sent),1)
  pwa_alerts.observe_group('x',self.state); pwa_alerts.observe_group('x',bad); pwa_alerts.observe_group('x',bad); self.assertEqual(len(self.sent),2)
 def test_unknown_and_intent_suppressed(self):
  self.assertFalse(pwa_alerts.observe_group('x',{'ok':False,'phase':'Unknown'}))
  pwa_alerts.set_intent('x',True)
  self.assertFalse(pwa_alerts.observe_group('x',{'ok':True,'replicas':1,'readyReplicas':0,'phase':'CrashLoopBackOff'})); self.assertFalse(self.sent)
 def test_recipients_policy(self):
  with patch.object(pwa_alerts.groups, 'load_state', return_value={'groups': {'g': {}}}), patch('users.list_users',return_value=[{'username':'a','role':'user'},{'username':'z','role':'admin'}]), patch('users.can_pod',side_effect=lambda u,p,l:u['username'] in ('a','z')):
   self.assertEqual(pwa_alerts._recipients('g'),{'a','z'})
 def test_webhook_claim_and_queue(self):
  payload={'_delivery_id':'d1','commits':[{'message':'fix'}]}
  self.assertTrue(pwa_alerts.enqueue_webhook('g',{'name':'d'},'r','main',payload)); self.assertFalse(pwa_alerts.enqueue_webhook('g',{'name':'d'},'r','main',payload))
  self.assertEqual(pwa_alerts.process_webhook_queue_once(),1); self.assertEqual(pwa_alerts.process_webhook_queue_once(),0)
if __name__=='__main__': unittest.main()
