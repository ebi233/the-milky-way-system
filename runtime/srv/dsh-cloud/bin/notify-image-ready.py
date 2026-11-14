"""Call immediately after reviewed final delivery, never from a periodic timer."""
from pathlib import Path
import json,re,sys,time,urllib.request,urllib.error

def notify(job_id):
    if not re.fullmatch('[a-f0-9]{32}',job_id):raise ValueError('Invalid job ID')
    home=Path('/srv/dsh-cloud/home')
    state=json.loads(Path('/srv/dsh-handoff/state.json').read_text())
    local=state.get('owner')=='local' and time.time()<state.get('expiresAt',0)
    base='http://127.0.0.1:'+('29938' if local else '29908')
    if local:
        auth=json.loads(Path('/srv/dsh-handoff/local-web-auth.json').read_text())
        if auth.get('epoch')!=state.get('epoch'):raise RuntimeError('Handover epoch mismatch')
        token=auth['token']
    else:token=(home/'.web-token').read_text().strip()
    url=base+'/dsh-draw/notify-owner?id='+job_id
    def request(method):
        req=urllib.request.Request(url,method=method,data=b'{}' if method=='POST' else None,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req,timeout=30) as r:return json.load(r)
        except urllib.error.HTTPError as e:
            raise RuntimeError('Notification endpoint rejected request: '+e.read(512).decode(errors='replace')) from None
    admitted=request('POST')
    for _ in range(50):
        state=request('GET')['notification']
        if state and state.get('phase') not in ('dispatching','notified'):break
        time.sleep(2)
    return {'jobId':job_id,'runtime':'local' if local else 'cloud','admission':admitted,'notification':state,'noScheduledTrigger':True}

if __name__=='__main__':
    result=notify(sys.argv[1]);print(json.dumps(result,ensure_ascii=False))
    if result['notification'].get('phase')!='sent':sys.exit(2)
