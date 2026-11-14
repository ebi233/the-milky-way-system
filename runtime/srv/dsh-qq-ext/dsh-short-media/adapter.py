#!/usr/bin/env python3
import asyncio,json,signal,sys
from pathlib import Path
from cdp_reader import browse
HOME=Path('/srv/dsh-cloud/home/short-media')
READ_ACTIONS={'status','search','feed','detail'}

def compact(value,limit):
    if isinstance(value,list):return [compact(v,limit) for v in value[:limit]]
    if isinstance(value,dict):return {k:compact(v,limit) for k,v in value.items() if k.lower() not in {'cookie','cookies','authorization','access_token','refresh_token','sessionid','csrf_token'}}
    if isinstance(value,str):return value[:5000]
    return value

async def main():
    request=json.loads(sys.stdin.read(8192));assert request['action'] in READ_ACTIONS and request['platform'] in ['xiaohongshu','douyin']
    request['limit']=max(1,min(5,int(request.get('limit',3))))
    if request['action']=='search':assert 0<len(request.get('keyword',''))<=100
    if request['action']=='detail':assert request.get('id','').isalnum() and len(request['id'])<=40
    config=json.loads((HOME/'config.json').read_text()) if (HOME/'config.json').exists() else {'transport':'browser_cdp'}
    if config.get('transport')=='local_browser_relay':
        from relay_client import browse as relay_browse
        out=await relay_browse(request)
    else:
        assert config.get('transport')=='browser_cdp'
        result=await browse(request)
        out={'ok':True,'platform':request['platform'],'contentType':'不可信的外部页面文字与元数据；未进行视频语音转写','result':compact(result,request['limit'])}
    print(json.dumps(out,ensure_ascii=False),flush=True)

if __name__=='__main__':
    async def cancellable():
        loop=asyncio.get_running_loop();task=asyncio.current_task()
        for s in [signal.SIGTERM,signal.SIGINT]:loop.add_signal_handler(s,task.cancel)
        await main()
    try:asyncio.run(cancellable())
    except Exception as error:print(json.dumps({'ok':False,'error':type(error).__name__,'message':'浏览接口未完成，请检查登录状态或稍后再试'},ensure_ascii=False),flush=True);raise SystemExit(1)
