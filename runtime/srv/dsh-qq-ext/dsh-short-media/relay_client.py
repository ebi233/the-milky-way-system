"""Read-only fixed localhost relay; SSH owns the remote forwarding transport."""
import asyncio,json,urllib.request,urllib.error
from pathlib import Path
KEY=Path('/srv/dsh-cloud/home/short-media/local-relay-key')
BASE='http://127.0.0.1:18081'

def request_sync(args):
    try:
        key=KEY.read_text().strip()
        request=urllib.request.Request(BASE+'/browse',data=json.dumps(args).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
        with urllib.request.urlopen(request,timeout=34) as response:data=response.read(60001)
        if len(data)>60000:raise ValueError('oversize')
        result=json.loads(data)
        if not isinstance(result,dict):raise ValueError('invalid result')
        return result
    except (OSError,ValueError):
        return {'ok':False,'error':'local_browser_offline','message':'本机浏览器连接不可用，请检查电脑和辅助程序；不要回退到云端重复尝试'}

async def browse(args):return await asyncio.to_thread(request_sync,args)
