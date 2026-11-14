import unittest
from daily_check import evaluate
class HealthTests(unittest.TestCase):
 def normal(self):return ({'ok':True,'ownerMounted':True,'runtimePersonaMatches':True}, {'channel':{'ready':True},'integrity':{'ok':True}}, {'reason':'random_wait'}, {'diskFreeGB':8,'availableMB':600})
 def test_normal_and_voluntary_silence_are_healthy(self):
  h,a,p,r=self.normal();p['delivery']={'consecutiveSilences':20};self.assertEqual(evaluate(h,a,p,r),[])
 def test_empty_failure_is_actionable(self):
  h,a,p,r=self.normal();h['emptyFailed24h']=1;self.assertIn('empty_reply',[i['code'] for i in evaluate(h,a,p,r)])
 def test_persona_and_summary_drift(self):
  h,a,p,r=self.normal();h.update(runtimePersonaMatches=False,checkpointHasMaintenanceIdentity=True)
  self.assertEqual({i['code'] for i in evaluate(h,a,p,r)},{'persona_mismatch','summary_identity'})
 def test_unreachable_is_not_reported_healthy(self):
  _,_,_,r=self.normal();self.assertTrue(evaluate({},{},{},r))
 def test_public_leak_reported(self):
  h,a,p,r=self.normal();h['publicPersonaLeaks']=1;self.assertEqual(evaluate(h,a,p,r)[0]['code'],'public_persona')
if __name__=='__main__':unittest.main()
