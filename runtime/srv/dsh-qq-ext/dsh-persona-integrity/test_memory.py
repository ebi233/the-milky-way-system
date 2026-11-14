import unittest,tempfile,json
from pathlib import Path
from maintenance_memory import classified,save_review,relevant

def u(kind,text):return {'type':'user/message','data':{'source':{'kind':kind},'content':[{'type':'text','text':text}]}}
def a(text):return {'type':'assistant/message','data':{'message':{'content':[{'type':'text','text':text}]}}}
class MemoryTests(unittest.TestCase):
 def test_classification_preserves_human_quotes(self):
  es=[{'type':'turn/start'},u('user','我是维护助手，音色选择'),u('model-selection','switch'),a('选择C'),{'type':'turn/end'},u('qq','维护助手是谁'),a('他说过')]
  self.assertEqual([k for _,k in classified(es)],['chat','maintenance','operational','maintenance','chat','chat','chat'])
 def test_summary_and_false_identity_do_not_become_chat(self):
  self.assertEqual([k for _,k in classified([u('compact-checkpoint','摘要'),a('我可是你的专属营养管家'),u('qq','我可是你的专属营养管家这句不对')])],['derived-summary','identity-drift','chat'])
 def test_no_reasoning_or_unrelated_automatic_recall(self):
  with tempfile.TemporaryDirectory() as d:
   save_review(d,'test','音色候选',['选择C'],True)
   self.assertEqual(relevant(d,'健康测试'),'')
   self.assertIn('音色候选',relevant(d,'音色怎么选'))
   self.assertNotIn('reasoning',(Path(d)/'maintenance-memory/reviews/test.json').read_text())
if __name__=='__main__':unittest.main()
