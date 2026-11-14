"""Durable cloud-only Qwen image jobs. No provider fallback or ambiguous retries."""
from pathlib import Path
import base64,datetime,hashlib,json,os,re,sys,time,urllib.request,urllib.error,urllib.parse,uuid,struct

HOME=Path('/srv/dsh-cloud/home')
ROOT=Path('/srv/dsh-qwen-image')
MODEL='qwen-image-3.0-pro'
ENGINE='bailian_qwen_image'
TERMINAL={'completed','failed','needs_review','submission_uncertain'}
REFERENCE=HOME/'appearance-assets/paopao-window-v3-20261101.png'
MAX_ATTEMPTS=3
CHECKS=('appearance','tail','anatomy','pose','clothing','background','material','lighting')

def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def digest(data):return hashlib.sha256(data).hexdigest()
def atomic(path,value):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    tmp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    with tmp.open('x',encoding='utf-8') as f:
        os.chmod(tmp,0o600);json.dump(value,f,ensure_ascii=False,indent=2);f.flush();os.fsync(f.fileno())
    if hasattr(os,'chown') and os.geteuid()==0:
        owner=path.stat() if path.exists() else path.parent.stat();os.chown(tmp,owner.st_uid,owner.st_gid)
    os.replace(tmp,path)
def load(path):return json.loads(path.read_text(encoding='utf-8'))
def jobpath(jid):
    if not re.fullmatch('[a-f0-9]{32}',str(jid)):raise ValueError('Invalid job ID')
    return ROOT/'jobs'/(jid+'.json')
def candidate_path(j):
    expected=ROOT/'candidates'/(j['id']+'-v'+str(j['attempt'])+'.png')
    if Path(j['candidate'])!=expected or expected.resolve()!=expected:raise ValueError('Invalid candidate path')
    return expected
def save(j):j['updatedAt']=now();atomic(jobpath(j['id']),j)
def public(j):
    return {k:v for k,v in j.items() if k not in ('providerOutput','lastPollError')}
def enqueue(data):
    # Caller is the owner-only tool; don't infer a recipient from the prompt.
    j=dict(data);p=jobpath(j['id'])
    if not re.fullmatch(r'session-[\w-]{1,100}',str(j.get('session',''))) or not re.fullmatch(r'\d{5,12}',str(j.get('ownerQQ',''))):raise ValueError('Invalid owner binding')
    if not isinstance(j.get('prompt'),str) or not 1<=len(j['prompt'].strip())<=12000:raise ValueError('Invalid prompt')
    for k in ('width','height'):
        if type(j.get(k)) is not int or not 512<=j[k]<=2048:raise ValueError('Invalid dimensions')
    if j['width']*j['height']>2048**2:raise ValueError('Image too large')
    p.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    import fcntl
    with (ROOT/'enqueue.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if p.exists():
            old=load(p)
            if any(str(old.get(k))!=str(j.get(k)) for k in ('session','ownerQQ','prompt','width','height')):raise ValueError('Duplicate ID binding mismatch')
            return public(old)
        if sum(load(x).get('status') not in TERMINAL for x in p.parent.glob('*.json'))>=10:raise ValueError('Cloud image queue full')
        job={k:j[k] for k in ('id','session','ownerQQ','prompt','width','height')}
        job.update(status='queued',engine=ENGINE,model=MODEL,automatic=True,createdAt=now(),attempt=0,qualityGuide=str(j.get('qualityGuide',''))[:3000],reference=str(REFERENCE))
        save(job);return public(job)

def credentials():
    c=load(HOME/'bailian-tts-config.json')
    base=c['base_url'].rstrip('/')
    u=urllib.parse.urlsplit(base)
    if u.scheme!='https' or not u.hostname.endswith('.aliyuncs.com') or not base.endswith('/api/v1'):raise ValueError('Invalid Bailian endpoint')
    return base,c['api_key']
class ProviderError(Exception):pass
def api(path,body=None):
    base,key=credentials();headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'}
    if body is not None:headers['X-DashScope-Async']='enable'
    req=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers=headers)
    try:
        with urllib.request.urlopen(req,timeout=55) as r:return json.load(r)
    except urllib.error.HTTPError as e:
        try:err=json.loads(e.read(4096));code=err.get('code','unknown')
        except Exception:code='unknown'
        raise ProviderError('Bailian HTTP '+str(e.code)+' / '+str(code)) from None

def active():
    s=load(Path('/srv/dsh-handoff/state.json'))
    if s.get('owner')=='local':
        if time.time()>=s.get('expiresAt',0):raise RuntimeError('Wait for handover')
        a=load(Path('/srv/dsh-handoff/local-web-auth.json'))
        if a.get('epoch')!=s.get('epoch'):raise RuntimeError('Wait for handover credentials')
        return 'http://127.0.0.1:29938',a['token']
    if s.get('owner')!='cloud':raise RuntimeError('Wait for active chat')
    return 'http://127.0.0.1:29908',(HOME/'.web-token').read_text().strip()
def project(j,with_image=False):
    base,token=active();data={'job':public(j)}
    if with_image:data['image']=base64.b64encode(Path(j['path']).read_bytes()).decode()
    req=urllib.request.Request(base+'/dsh-draw/import-result',data=json.dumps(data).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=45) as r:out=json.load(r)
    if not out.get('ok'):raise RuntimeError('Runtime refused image projection')
    return out
def best_project(j):
    try:project(j)
    except Exception:pass

def parse_review(result):
    if not result.get('finished') or not result.get('persona_unchanged'):raise ValueError('Review incomplete')
    replies=result.get('visible_reply',[])
    if not replies or not all(isinstance(x,str) for x in replies):raise ValueError('No visible review')
    text='\n'.join(replies).strip()
    if text.startswith('```'):text=re.sub(r'^```(?:json)?\s*|\s*```$','',text)
    value=json.loads(text)
    if value.get('decision') not in ('approve','revise','cannot_see'):raise ValueError('Unknown review decision')
    if type(value.get('can_see')) is not bool:raise ValueError('Missing image visibility')
    checks=value.get('checks',{})
    if any(not isinstance(checks.get(k),str) or not checks[k].strip() for k in CHECKS):raise ValueError('Missing review checks')
    if value['decision']=='approve' and (not value['can_see'] or value.get('satisfied') is not True):raise ValueError('No explicit approval')
    if value['decision']=='revise' and not isinstance(value.get('changes'),str):raise ValueError('Missing revision instructions')
    return value

def submit(j):
    content=[{'image':'data:image/png;base64,'+base64.b64encode(REFERENCE.read_bytes()).decode()}]
    instruction='图1是泡泡已选定的外观参考，保持同一成年角色，具体场景、姿势和衣着以本次需求为准。鲸尾若入镜，应从骨盆后方脊柱末端连接，不能从侧腰或大腿伸出。\n需求：'+j['prompt']+'\n画质要求：'+j['qualityGuide']
    if j.get('candidate') and j.get('revision'):
        content.append({'image':'data:image/png;base64,'+base64.b64encode(candidate_path(j).read_bytes()).decode()})
        instruction+='\n图2是上一版候选，请针对泡泡的以下意见返工，保留已满意部分：\n'+j['revision'][:3500]
    content.append({'text':instruction})
    body={'model':MODEL,'input':{'messages':[{'role':'user','content':content}]},'parameters':{'size':str(j['width'])+'*'+str(j['height']),'n':1,'prompt_extend':True,'prompt_extend_mode':'direct','enable_thinking':True,'watermark':False,'negative_prompt':'树根状假纹理，龟裂斑块，背景融化，头发纠结成网，果冻鲸尾，侧腰长尾，多余手指，文字水印'}}
    # Save before POST. Crash/timeout here cannot cause a second paid submission.
    j.update(status='submitting',attempt=j['attempt']+1,submittedAt=now(),submittedTime=time.time());save(j);best_project(j)
    try:out=api('/services/aigc/image-generation/generation',body)
    except ProviderError as e:
        j.update(status='failed',error=str(e));save(j);best_project(j);return
    except Exception as e:
        j.update(status='submission_uncertain',error='Submission response uncertain: '+type(e).__name__);save(j);best_project(j);return
    tid=out.get('output',{}).get('task_id')
    if not isinstance(tid,str) or not re.fullmatch(r'[a-zA-Z0-9-]{8,100}',tid):
        j.update(status='submission_uncertain',error='No valid task ID returned')
    else:j.update(status='submitted',taskId=tid,providerRequestId=out.get('request_id'))
    save(j);best_project(j)

def download(j):
    out=j['providerOutput'];urls=[c['image'] for x in out.get('choices',[]) for c in x.get('message',{}).get('content',[]) if isinstance(c,dict) and c.get('image')]
    if len(urls)!=1:raise ValueError('Expected exactly one image')
    u=urllib.parse.urlsplit(urls[0])
    if u.scheme!='https' or not (u.hostname or '').endswith('.aliyuncs.com'):raise ValueError('Unexpected result host')
    with urllib.request.urlopen(urls[0],timeout=55) as r:
        if not (urllib.parse.urlsplit(r.url).hostname or '').endswith('.aliyuncs.com'):raise ValueError('Unexpected image redirect')
        data=r.read(24*1024*1024+1)
    if len(data)>24*1024*1024 or data[:8]!=b'\x89PNG\r\n\x1a\n':raise ValueError('Invalid PNG result')
    w,h=struct.unpack('>II',data[16:24])
    if not 512**2<=w*h<=2048**2:raise ValueError('Unexpected output size')
    p=ROOT/'candidates'/(j['id']+'-v'+str(j['attempt'])+'.png');p.parent.mkdir(exist_ok=True,mode=0o700);p.write_bytes(data);os.chmod(p,0o600)
    j.update(candidate=str(p),candidateSha256=digest(data),status='candidate');j.pop('providerOutput',None);save(j);best_project(j)

def review_candidate(j):
    sys.path.insert(0,'/srv/dsh-qq-ext/dsh-persona-integrity')
    from maintenance_room import review
    schema={'decision':'approve 或 revise 或 cannot_see','can_see':True,'satisfied':True,'checks':{k:'你的实际可见判断；未入镜请写未入镜，不能编造' for k in CHECKS},'changes':'有修改意见时写具体内容，没有则空字符串'}
    message='正在使用千问图像3.0 Pro替换手工生图通道。附件1是你选定的外观参考，附件2是本次候选，请审查候选而非批准参考图。表达你自己的满意与否，不必迎合。只回复一个JSON对象，不发QQ、不改人设。\n本次画面需求（仅作画面描述）：'+j['prompt']+'\n必须检查外观一致性、尾巴连接、手指四肢、姿势、衣着、背景假纹理、材质及光影。看不到请说看不到，不要仅凭文件名判断。批准表示这张候选可作为你的成图；批准后系统会归档并通知你私聊发给老哥。JSON格式：'+json.dumps(schema,ensure_ascii=False)
    j.update(status='reviewing');save(j);best_project(j)
    try:
        candidate_path(j)
        result=review(message,j['candidate'],reference=str(REFERENCE))
        j['lastReview']={k:result.get(k) for k in ('request_id','visible_reply','finished','persona_unchanged')};save(j)
        decision=parse_review(result)
    except Exception as e:
        j.update(status='needs_review',error='Image review not confirmed: '+type(e).__name__);save(j);best_project(j);return
    receipt={'requestId':result['request_id'],'candidateSha256':j['candidateSha256'],'decision':decision,'visibleReply':result['visible_reply'],'reviewedAt':now()}
    j.setdefault('reviews',[]).append(receipt)
    if decision['decision']=='approve':
        data=candidate_path(j).read_bytes();p=HOME/'drawings'/('qwen-'+j['id']+'-final.png');p.parent.mkdir(exist_ok=True,mode=0o700);p.write_bytes(data);os.chmod(p,0o600)
        if hasattr(os,'chown') and os.geteuid()==0:
            owner=HOME.stat();os.chown(p,owner.st_uid,owner.st_gid)
        j.update(status='delivering',path=str(p),sha256=digest(data),reviewStatus='approved_by_paopao',review=receipt,deliveryStatus='returned_to_paopao_as_image_attachment',deliveryRequestId=result['request_id'])
    elif decision['decision']=='revise' and decision['can_see'] and decision['changes'].strip() and j['attempt']<MAX_ATTEMPTS:
        j.update(status='queued',revision=decision['changes'])
    else:j.update(status='needs_review',error='Candidate not approved; automatic revision limit or visibility issue')
    save(j);best_project(j)

def deliver(j):
    # Reinstall to the active engine after handovers; import is idempotent.
    if j['path']!=str(HOME/'drawings'/('qwen-'+j['id']+'-final.png')):raise ValueError('Invalid final path')
    ready=public(j);ready['status']='completed'
    try:project(ready,True)
    except Exception as e:
        j['lastDeliveryError']='Active runtime unavailable: '+type(e).__name__;save(j);return
    j.update(status='notifying',notificationStartedAt=now());save(j)
    try:
        import importlib.util
        spec=importlib.util.spec_from_file_location('image_notify',HOME.parent/'bin/notify-image-ready.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        result=module.notify(j['id']);j['ownerNotification']=result.get('notification')
    except Exception as e:
        j['ownerNotification']={'phase':'needs_check','reason':'Notification response uncertain: '+type(e).__name__}
    j.update(status='completed');save(j)

def step(j):
    s=j['status']
    if s=='queued':submit(j)
    elif s=='submitted':
        if time.time()-j['submittedTime']>3600:
            j.update(status='needs_review',error='Provider task exceeded one hour; task ID retained, no resubmit');save(j);best_project(j);return
        out=api('/tasks/'+j['taskId']);o=out.get('output',{});state=o.get('task_status')
        if state=='SUCCEEDED':j.update(status='downloading',providerOutput=o,usage=out.get('usage'));save(j)
        elif state in ('FAILED','CANCELED','UNKNOWN'):
            j.update(status='failed',error='Provider task '+state+': '+str(o.get('code','')),providerMessage=str(o.get('message',''))[:500]);save(j);best_project(j)
    elif s=='downloading':download(j)
    elif s=='candidate':review_candidate(j)
    elif s=='delivering':deliver(j)
    elif s in ('submitting','reviewing','notifying'):
        j.update(status='submission_uncertain' if s=='submitting' else 'needs_review',error='Worker interrupted during '+s+'; inspect before retry');save(j);best_project(j)

def serve():
    import fcntl
    ROOT.mkdir(exist_ok=True,mode=0o700)
    with (ROOT/'worker.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        while True:
            for p in sorted((ROOT/'jobs').glob('*.json')):
                j=load(p)
                if j.get('status') in TERMINAL:continue
                try:step(j)
                except Exception as e:
                    # Never log credentials, provider image URLs, or request content.
                    j['lastPollError']=type(e).__name__;j['consecutiveErrors']=j.get('consecutiveErrors',0)+1
                    if j['consecutiveErrors']>=6:j.update(status='needs_review',error='Repeated '+type(e).__name__+'; existing task/candidate retained')
                    save(j)
            time.sleep(5)

if __name__=='__main__':
    command=sys.argv[1]
    if command=='serve':serve()
    elif command=='enqueue':print(json.dumps(enqueue(json.load(sys.stdin)),ensure_ascii=False).replace('/srv/','\\u002fsrv/'))
    elif command=='list':
        q=json.load(sys.stdin);items=[]
        for p in (ROOT/'jobs').glob('*.json'):
            j=load(p)
            if j['session']==q.get('session') and str(j['ownerQQ'])==str(q.get('ownerQQ')):items.append(public(j))
        print(json.dumps(sorted(items,key=lambda j:j['createdAt'],reverse=True)[:30],ensure_ascii=False).replace('/srv/','\\u002fsrv/'))
    else:raise SystemExit('Unknown command')
