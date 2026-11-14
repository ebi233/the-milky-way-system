"""Bounded adapter for the existing document reader; never execute document content."""
import contextlib,importlib.util,io,json,resource,sys,zipfile
from pathlib import Path
resource.setrlimit(resource.RLIMIT_AS,(512*1024*1024,512*1024*1024))
resource.setrlimit(resource.RLIMIT_CPU,(15,15))
MAX=200000
def main():
 p=Path(sys.argv[1]);ext=p.suffix.lower()
 if p.stat().st_size>16*1024*1024:raise ValueError('TOO_LARGE')
 if ext in ['.docx','.xlsx','.pptx']:
  with zipfile.ZipFile(p) as z:
   files=z.infolist()
   if len(files)>4000 or sum(f.file_size for f in files)>64*1024*1024:raise ValueError('ARCHIVE_LIMIT')
 if ext=='.doc':raise ValueError('LEGACY_DOC')
 spec=importlib.util.spec_from_file_location('existing_reader','/srv/dsh-cloud/bin/doc-read.py')
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 with contextlib.redirect_stdout(io.StringIO()):
  if ext=='.pdf':text=module.read_pdf(p)
  elif ext=='.docx':text=module.read_docx(p)
  elif ext=='.xlsx':text=module.read_xlsx(p,'')
  elif ext=='.pptx':text=module.read_pptx(p)
  else:text=p.read_text(encoding='utf-8',errors='replace')
 if not text.strip():raise ValueError('NO_TEXT')
 return dict(ok=True,text=text[:MAX],truncated=len(text)>MAX,total_chars=len(text))
try:print(json.dumps(main(),ensure_ascii=True))
except Exception as e:
 code=str(e) if isinstance(e,ValueError) and str(e) in ['TOO_LARGE','ARCHIVE_LIMIT','LEGACY_DOC','NO_TEXT'] else 'EXTRACT_FAILED'
 print(json.dumps(dict(ok=False,code=code)));sys.exit(1)
