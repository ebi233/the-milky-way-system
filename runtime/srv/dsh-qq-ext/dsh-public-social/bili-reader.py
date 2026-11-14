"""Bounded read-only adapter for the bilibili-api-python already installed by bili-duty.
Uses the subtitle/comment flow of the existing MIT bilibili-mcp integration.
No login, media download, account writes, model calls or private messages.
"""
import asyncio,json,re,sys
from pathlib import Path
from urllib.parse import urlsplit

def excerpt(text,limit=1800):
    if len(text)<=limit:return text,False
    n=(limit-12)//3
    return text[:n]+'\n[…]\n'+text[len(text)//2:len(text)//2+n]+'\n[…]\n'+text[-n:],True

def code(exc):
    if isinstance(exc,(asyncio.TimeoutError,TimeoutError)):return 'timeout'
    n=getattr(exc,'code',None)
    if n in (-101,-111):return 'login_required'
    if n in (-352,-412):return 'platform_restricted'
    return 'read_failed'

def safe_url(raw):
    value='https:'+raw if raw.startswith('//') else raw
    p=urlsplit(value)
    host=(p.hostname or '').lower()
    if p.scheme!='https' or p.username or p.password or p.port not in (None,443) or not any(host==d or host.endswith('.'+d) for d in ['hdslb.com','bilibili.com']):
        raise ValueError('invalid subtitle source')
    return value

async def run(home,bvid):
    from bilibili_api import video,comment,Credential
    import aiohttp
    try:
        raw=json.loads((Path(home)/'bili-duty/bili_credential.json').read_text())
        cred=Credential(**{k:raw.get(k) or '' for k in ['sessdata','bili_jct','buvid3','dedeuserid']})
        present=bool(raw.get('sessdata'))
    except (OSError,ValueError,TypeError):cred=Credential();present=False
    result={'bvid':bvid,'credentialPresent':present,'subtitle':{'status':'not_attempted'},'comments':{'status':'not_attempted'}}
    v=video.Video(bvid=bvid,credential=cred)
    try:info=await asyncio.wait_for(v.get_info(),5)
    except Exception as e:
        result['subtitle']['status']=result['comments']['status']=code(e);return result
    cid=info.get('cid') or next(iter(info.get('pages') or [{}])).get('cid')
    async def subtitles():
        if not cid:return {'status':'no_subtitle'}
        listing=await v.get_subtitle(cid=cid)
        tracks=listing.get('subtitles') or []
        if not tracks:return {'status':'login_required' if listing.get('need_login_subtitle') else 'no_subtitle'}
        target=next((t for t in tracks if t.get('lan') in ['zh-CN','zh','ai-zh']),tracks[0])
        url=safe_url(target.get('subtitle_url',''))
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as session:
            async with session.get(url,allow_redirects=False) as resp:
                if resp.status!=200:raise ValueError('subtitle http error')
                data=bytearray()
                async for chunk in resp.content.iter_chunked(16384):
                    data.extend(chunk)
                    if len(data)>2*1024*1024:return {'status':'result_limit'}
                body=json.loads(data).get('body') or []
        text='\n'.join(str(row.get('content','')) for row in body)
        if not text.strip():return {'status':'no_subtitle'}
        sample,truncated=excerpt(text)
        return {'status':'read','text':sample,'truncated':truncated,'totalCharacters':len(text),'segments':len(body),'language':str(target.get('lan',''))[:20],'scope':'first_part'}
    try:result['subtitle']=await asyncio.wait_for(subtitles(),8)
    except Exception as e:result['subtitle']={'status':code(e)}
    try:
        data=await asyncio.wait_for(comment.get_comments(oid=int(info['aid']),type_=comment.CommentResourceType.VIDEO,page_index=1,order=comment.OrderType.LIKE,credential=cred),5)
        # Public comment text only. Never pass usernames, account IDs or nested replies.
        snippets=[str(r.get('content',{}).get('message',''))[:120] for r in (data.get('replies') or [])[:3]]
        result['comments']={'status':'read' if snippets else 'empty','snippets':snippets}
    except Exception as e:result['comments']={'status':code(e)}
    return result

if __name__=='__main__':
    if len(sys.argv)!=3 or not re.fullmatch(r'BV[0-9A-Za-z]{10}',sys.argv[2]):raise SystemExit(2)
    try:result=asyncio.run(asyncio.wait_for(run(sys.argv[1],sys.argv[2]),20))
    except Exception as e:result={'bvid':sys.argv[2],'subtitle':{'status':code(e)},'comments':{'status':code(e)}}
    print(json.dumps(result,ensure_ascii=False))
