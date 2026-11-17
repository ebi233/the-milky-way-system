from pathlib import Path
import importlib.util,unittest
from types import SimpleNamespace as N
p=Path(__file__).resolve().parents[1]/'runtime/srv/dsh-qq-ext/dsh-public-social/tieba-api-reader.py'
s=importlib.util.spec_from_file_location('reader',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Rows(list):
 def __init__(self,*,name='花',fid=5563,tid=123456):
  super().__init__([N(pid=9,tid=tid,text='今天早上新开了一朵花')]);self.forum=N(fname=name,fid=fid);self.thread=N(tid=tid,title='阳台上的花')
class AliasTests(unittest.TestCase):
 def test_alias_keeps_requested_and_canonical_names(self):
  rows=Rows();name,fid=m.resolve_forum(rows,'花卉');r=m.project_resolved(rows,'花卉',name,fid,123456)
  self.assertEqual(r['forum'],'花卉');self.assertEqual(r['resolvedForum'],'花');self.assertEqual(r['forumId'],5563)
 def test_same_name_wrong_id_rejected(self):
  with self.assertRaisesRegex(m.ReadError,'source_mismatch'):m.project_resolved(Rows(fid=8888),'花卉','花',5563,123456)
 def test_same_id_wrong_name_rejected(self):
  with self.assertRaisesRegex(m.ReadError,'source_mismatch'):m.project_resolved(Rows(name='其他吧'),'花卉','花',5563,123456)
 def test_wrong_thread_rejected(self):
  with self.assertRaisesRegex(m.ReadError,'source_mismatch'):m.project_resolved(Rows(tid=654321),'花卉','花',5563,123456)
 def test_invalid_resolved_forum_rejected(self):
  for rows in [Rows(name=''),Rows(name='../x'),Rows(fid=0),Rows(fid=True)]:
   with self.assertRaisesRegex(m.ReadError,'source_mismatch'):m.resolve_forum(rows,'花卉')
if __name__=='__main__':unittest.main()
