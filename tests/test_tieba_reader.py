import importlib.util,unittest
from pathlib import Path
from types import SimpleNamespace as N
spec=importlib.util.spec_from_file_location('reader',Path(__file__).resolve().parents[1]/'runtime/srv/dsh-qq-ext/dsh-public-social/tieba-api-reader.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Rows(list):
 def __init__(self,rows,forum='花卉',tid=123456):super().__init__(rows);self.forum=N(fname=forum);self.thread=N(tid=tid,title='阳台花开了')
def post(pid=1,tid=123456,text='今天早上新开了一朵花'):return N(pid=pid,tid=tid,text=text,user=N(nick_name='不应记录的名字'))
def thread(tid=123456,**kw):return N(tid=tid,is_top=kw.get('top',False),is_hide=kw.get('hide',False),reply_num=kw.get('reply',2))
class ReaderTests(unittest.TestCase):
 def test_exact_text_without_author_profile(self):
  r=m.project_posts(Rows([post()]),'花卉',123456);self.assertEqual(r['posts'],['今天早上新开了一朵花']);self.assertNotIn('不应记录',str(r));self.assertEqual(r['reader'],'aiotieba-4.8.4')
 def test_wrong_forum(self):
  with self.assertRaisesRegex(m.ReadError,'source_mismatch'):m.project_posts(Rows([post()],forum='其他'),'花卉',123456)
 def test_wrong_thread(self):
  for rows in [Rows([post(tid=654321)]),Rows([post()],tid=654321)]:
   with self.assertRaisesRegex(m.ReadError,'source_mismatch'):m.project_posts(rows,'花卉',123456)
 def test_duplicate_posts(self):
  with self.assertRaisesRegex(m.ReadError,'source_mismatch'):m.project_posts(Rows([post(),post()]),'花卉',123456)
 def test_oversize_post_not_truncated_into_safe_quote(self):
  with self.assertRaisesRegex(m.ReadError,'filtered'):m.project_posts(Rows([post(text='花'*601)]),'花卉',123456)
 def test_empty_not_success(self):
  with self.assertRaisesRegex(m.ReadError,'no_rendered_results'):m.project_posts(Rows([]),'花卉',123456)
 def test_seen_hidden_and_sticky_skipped(self):
  ts=Rows([thread(top=True),thread(tid=222222,hide=True),thread(tid=333333),thread(tid=444444)])
  self.assertEqual(m.select_thread(ts,'花卉',['tieba:333333']),444444)
 def test_no_reply_not_language_material(self):
  with self.assertRaisesRegex(m.ReadError,'no_new_public_material'):m.select_thread(Rows([thread(reply=0)]),'花卉',[])
 def test_scope_mismatch_cannot_be_followed(self):
  with self.assertRaisesRegex(m.ReadError,'source_mismatch'):m.select_thread(Rows([thread()],forum='别的吧'),'花卉',[])
 def test_forged_thread_id(self):
  with self.assertRaisesRegex(m.ReadError,'no_new_public_material'):m.select_thread(Rows([thread(tid='123456')]),'花卉',[])
if __name__=='__main__':unittest.main()
