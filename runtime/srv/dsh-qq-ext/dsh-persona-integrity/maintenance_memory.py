"""Separate visible creative/maintenance records from human chat. No LLM calls."""
from pathlib import Path
import datetime as dt, hashlib, json, os, re, subprocess, threading
from collections import deque
from contextlib import contextmanager

MARKER=re.compile(r'维护助手|维护沟通|获准的.*审图|维护复核|老哥已经授权固定创作流程')
DRIFT=re.compile(r'我(?:可是|是)你的专属营养管家')
TZ=dt.timezone(dt.timedelta(hours=8))

@contextmanager
def archive_lock(home):
    import fcntl
    p=Path(home)/'runtime-health'/'archive.lock';p.parent.mkdir(exist_ok=True)
    with p.open('a') as f:
        fcntl.flock(f,fcntl.LOCK_EX)
        yield

def message(event):
    d=event.get('data') or {}
    return d.get('message') or d

def visible(event):
    content=message(event).get('content',[])
    if isinstance(content,str):return content.strip()
    return '\n'.join(b.get('text','').strip() for b in content if b.get('type')=='text' and b.get('text','').strip())

def maintenance(msg):
    return msg.get('source',{}).get('kind')=='user' and bool(MARKER.search(visible({'data':msg})))

def classified(events):
    active=False
    for event in events:
        typ=event.get('type');msg=message(event);source=msg.get('source',{}).get('kind')
        if typ=='turn/start':active=False
        if typ=='user/message' and source not in ('model-selection','compact-checkpoint','agent-instructions'):
            active=maintenance(msg)
        if typ=='user/message' and source=='compact-checkpoint':kind='derived-summary'
        elif typ=='user/message' and source not in ('qq','user'):kind='operational'
        elif typ in ('user/message','assistant/message') and active:kind='maintenance'
        elif typ=='assistant/message' and DRIFT.search(visible(event)):kind='identity-drift'
        else:kind='chat'
        yield event,kind
        if typ=='turn/end':active=False

def iter_json_events(stream,max_line=2*1024*1024,max_total=256*1024*1024):
    total=0
    while True:
        line=stream.readline(max_line+1)
        if not line:return
        total+=len(line)
        if len(line)>max_line or total>max_total:raise RuntimeError('HISTORY_RESOURCE_LIMIT')
        if line.strip():yield json.loads(line)

def load_events(path):
    """One bounded event at a time; child dies on timeout, error or early close."""
    proc=subprocess.Popen(['zstd','-dc','--',str(path)],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    expired=threading.Event()
    def deadline():
        expired.set()
        try:proc.kill()
        except ProcessLookupError:pass
    timer=threading.Timer(30,deadline);timer.daemon=True;timer.start()
    try:
        yield from iter_json_events(proc.stdout)
        if proc.wait(timeout=5)!=0 or expired.is_set():raise RuntimeError('HISTORY_READ_FAILED')
    finally:
        timer.cancel();proc.stdout.close()
        if proc.poll() is None:proc.kill()
        proc.wait(timeout=5)


def put_json(path,data):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temp=path.with_suffix(path.suffix+'.tmp')
    temp.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    temp.chmod(0o600);os.replace(temp,path)

def save_review(home,request_id,prompt,replies,finished,image_name=None):
    root=Path(home)/'maintenance-memory'/'reviews'
    put_json(root/(request_id+'.json'),{'version':1,'kind':'maintenance','at':int(dt.datetime.now().timestamp()*1000),
      'requestId':request_id,'sessionId':'session-maintenance-creative-review','prompt':prompt,'visibleReplies':replies,
      'finished':finished,'attachmentName':image_name,'participants':['maintenance-assistant','paopao']})

def relevant(home,query,limit=6000):
    """Opt-in topic lookup, never automatic injection into a human chat."""
    keys=[]
    if re.search('图|外观|尾巴|头发|自拍|画',query):keys+=['图','外观','尾巴','画']
    if re.search('声音|音色|样音|语音|试听',query):keys+=['音色','声音','样音','试听']
    if not keys:return ''
    root=Path(home)/'maintenance-memory';records=[]
    p=root/'imported-visible.jsonl'
    if p.exists():
        with p.open('rb') as f:
            records=list(deque((r for r in iter_json_events(f) if any(k in r.get('text','') for k in keys)),maxlen=32))
    for p in sorted((root/'reviews').glob('*.json'),key=lambda p:p.stat().st_mtime)[-20:]:
        if p.stat().st_size>262144:raise RuntimeError('REVIEW_RESOURCE_LIMIT')
        r=json.loads(p.read_text(encoding='utf-8'))
        records.append({'role':'maintenance-assistant','text':r['prompt']})
        records.extend({'role':'paopao','text':t} for t in r['visibleReplies'])
    matches=[{'role':r['role'],'text':r['text'][:1800]} for r in records if any(k in r['text'] for k in keys)]
    out=[];size=0
    for r in reversed(matches):
        s=json.dumps(r,ensure_ascii=False)
        if size+len(s)>limit:break
        out.append(s);size+=len(s)
    return '\n'.join(reversed(out))

def migrate(home,apply=False):
    home=Path(home);sid=(home/'.main-session').read_text().strip()
    paths=list((home/'sessions').glob('*/'+sid+'/session.v4.jsonl.zstd'))
    if len(paths)!=1:raise RuntimeError('Cannot identify owner session uniquely')
    events=load_events(paths[0]);records=[];remove=set();counts={};ids=[];material_bytes=0
    for e,kind in classified(events):
        if kind=='chat':continue
        if sum(counts.values())>=10000:raise RuntimeError('MIGRATION_RESOURCE_LIMIT_USE_OFFLINE')
        text=visible(e)
        if not text:continue
        material_bytes+=len(text.encode('utf-8'))
        if material_bytes>8*1024*1024:raise RuntimeError('MIGRATION_RESOURCE_LIMIT_USE_OFFLINE')
        when=dt.datetime.fromtimestamp(e['time']/1000,TZ)
        role='泡泡' if e['type']=='assistant/message' else '老哥'
        remove.add((str(when.date()),when.strftime('%H:%M:%S'),role,text[:4000]))
        counts[kind]=counts.get(kind,0)+1
        if kind=='maintenance':
            records.append({'version':1,'kind':kind,'sourceSession':sid,'sourceSeq':e['seq'],'at':e['time'],
                'messageId':message(e).get('id'),'role':'paopao' if role=='泡泡' else 'maintenance-assistant','text':text})
            if e['type']=='user/message':ids.append(message(e).get('id'))
    staged=[];removed=0
    for p in sorted((home/'archive').glob('????-??-??.jsonl')):
        keep=[]
        for line in p.read_text(encoding='utf-8').splitlines():
            r=json.loads(line)
            if (p.stem,r.get('t'),r.get('role'),r.get('text')) in remove:removed+=1
            else:keep.append(line)
        if len(keep)!=len(p.read_text(encoding='utf-8').splitlines()):staged.append((p,'\n'.join(keep)+'\n'))
    report={'version':1,'sourceSession':sid,'eventCounts':counts,'maintenanceRequests':len(ids),'archiveRowsMoved':removed,
      'archiveFilesChanged':len(staged),'personaUnchanged':True}
    if apply:
        root=home/'maintenance-memory';root.mkdir(mode=0o700,exist_ok=True)
        (root/'imported-visible.jsonl').write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in records),encoding='utf-8')
        put_json(root/'migration.json',report)
        put_json(root/'excluded-message-ids.json',{'sessionId':sid,'messageIds':ids})
        (root/'README.md').write_text('独立维护记忆库\n\n仅包含维护助手与泡泡的可见交流，不含内部推理。审图、音色选择和维护时按主题读取；不作为主账号、访客或群聊的记忆与身份指令。原生会话日志保留审计，日常回忆入口排除这些维护轮次。\n',encoding='utf-8')
        backup=home.parent/'persona-integrity-backup-20261101'/'archive-before-separation'
        backup.mkdir(parents=True,exist_ok=True,mode=0o700)
        for p,text in staged:
            target=backup/p.name
            if not target.exists():target.write_bytes(p.read_bytes())
            temp=p.with_suffix('.separation.tmp');temp.write_text(text,encoding='utf-8');temp.chmod(0o600);os.replace(temp,p)
    return report

if __name__=='__main__':
    import argparse
    ap=argparse.ArgumentParser();ap.add_argument('--home',default='/srv/dsh-cloud/home');ap.add_argument('--apply',action='store_true')
    args=ap.parse_args()
    with archive_lock(args.home):print(json.dumps(migrate(args.home,args.apply),ensure_ascii=False))
