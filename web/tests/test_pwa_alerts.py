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
  # 冻结时钟: pod-down event_key 含 int(updated) 秒级时间戳, 同秒内重复告警会
  # 命中同一 key 而被去重。不冻结时跨秒会额外触发一次, 测试随机变红。
  bad={'ok':True,'replicas':1,'readyReplicas':0,'phase':'CrashLoopBackOff'}
  with patch.object(pwa_alerts.time,'time',return_value=1000.0):
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

 def _claim(self, key, kind, group, recipients):
  self.assertTrue(pwa_alerts._claim_alert(key, kind, group, {'title': key}, recipients))

 def test_events_are_scoped_to_recipients(self):
  # pod 事件只对成员可见; 广播(recipients=None/NULL)人人可见
  self._claim('pod-down:g:1', 'pod-down', 'g', ['alice','bob'])
  self._claim('broadcast:1', 'broadcast', '*', None)
  keys_alice = {e['event_key'] for e in pwa_alerts.list_events('alice')[0]}
  keys_carol = {e['event_key'] for e in pwa_alerts.list_events('carol')[0]}
  self.assertEqual(keys_alice, {'pod-down:g:1','broadcast:1'})
  self.assertEqual(keys_carol, {'broadcast:1'})

 def test_admin_only_and_single_user_events(self):
  self._claim('cert:1', 'cert-expiry', 'platform', ['admin1'])
  self._claim('quota:1', 'quota-warn', 'alice', ['alice'])
  self._claim('pod-down:g:2', 'pod-down', 'g', ['alice','bob'])
  # admin 看得到 cert; 普通 a 看不到
  self.assertIn('cert:1', {e['event_key'] for e in pwa_alerts.list_events('admin1')[0]})
  self.assertNotIn('cert:1', {e['event_key'] for e in pwa_alerts.list_events('alice')[0]})
  # 单用户配额预警只有本人可见
  self.assertIn('quota:1', {e['event_key'] for e in pwa_alerts.list_events('alice')[0]})
  self.assertNotIn('quota:1', {e['event_key'] for e in pwa_alerts.list_events('bob')[0]})

 def test_per_user_read_state(self):
  self._claim('pod-down:g:3', 'pod-down', 'g', ['alice','bob'])
  self._claim('broadcast:2', 'broadcast', '*', None)
  # alice 读掉 pod 事件 → 她的未读=1(广播), bob 未读仍=2
  self.assertEqual(pwa_alerts.mark_read('alice', event_keys=['pod-down:g:3']), 1)
  self.assertEqual(pwa_alerts.list_events('alice')[2], 1)
  self.assertEqual(pwa_alerts.list_events('bob')[2], 2)
  alice = {e['event_key']: e['read'] for e in pwa_alerts.list_events('alice')[0]}
  self.assertTrue(alice['pod-down:g:3']); self.assertFalse(alice['broadcast:2'])
  # 幂等: 重复标记不再计数
  self.assertEqual(pwa_alerts.mark_read('alice', event_keys=['pod-down:g:3']), 0)

 def test_mark_all_only_touches_visible(self):
  self._claim('pod-down:g:4', 'pod-down', 'g', ['alice','bob'])
  self._claim('cert:2', 'cert-expiry', 'platform', ['admin1'])
  # carol 什么都看不到 → 全部已读不产生任何行
  self.assertEqual(pwa_alerts.mark_read('carol', all=True), 0)
  # alice 只能标记到自己可见的那条
  self.assertEqual(pwa_alerts.mark_read('alice', all=True), 1)
  self.assertEqual(pwa_alerts.list_events('alice')[2], 0)
  self.assertEqual(pwa_alerts.list_events('bob')[2], 1)
  self.assertEqual(pwa_alerts.list_events('admin1')[2], 1)

 def test_kind_filter_and_unread_are_user_scoped(self):
  self._claim('pod-down:g:5', 'pod-down', 'g', ['alice'])
  self._claim('deploy:g:5', 'deploy-webhook', 'g', ['alice'])
  evs, total, unread = pwa_alerts.list_events('alice', kind='pod-down')
  self.assertEqual([e['event_key'] for e in evs], ['pod-down:g:5'])
  self.assertEqual(total, 1)      # kind 过滤后的可见条数
  self.assertEqual(unread, 2)     # 未读角标不看 kind
if __name__=='__main__': unittest.main()
