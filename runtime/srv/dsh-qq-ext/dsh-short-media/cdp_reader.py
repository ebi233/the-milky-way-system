"""Platform-specific, read-only pages in the existing local browser.

No browser restart, arbitrary URLs, account mutation or private DSH page reads.
Every created tab is closed on completion or cooperative cancellation.
"""
import asyncio,json,time,os
from pathlib import Path
from urllib.parse import quote,urlparse,parse_qs
import httpx,websockets

HOME=Path('/srv/dsh-cloud/home/short-media')
BASE='http://127.0.0.1:9222'
class PageNavigating(RuntimeError):pass

def page_url(r):
    site=r['platform'];action=r['action']
    if site=='xiaohongshu':
        if action=='search':return 'https://www.xiaohongshu.com/search_result?keyword='+quote(r['keyword'],safe='')
        if action=='detail':return 'https://www.xiaohongshu.com/explore/'+r['id']+'?xsec_token='+quote(r.get('token',''),safe='')+'&xsec_source=pc_search'
        return 'https://www.xiaohongshu.com/explore'
    if action=='search':return 'https://www.douyin.com/search/'+quote(r['keyword'],safe='')+'?type=video'
    if action=='detail':return 'https://www.douyin.com/video/'+r['id']
    return 'https://www.douyin.com/'

class CDP:
    def __init__(self,ws):self.ws=ws;self.seq=0
    async def call(self,method,params=None):
        self.seq+=1;seq=self.seq
        await self.ws.send(json.dumps({'id':seq,'method':method,'params':params or {}}))
        async with asyncio.timeout(8):
            while True:
                response=json.loads(await self.ws.recv())
                if response.get('id')!=seq:continue
                if 'error' in response:
                    message=str(response['error'].get('message','')).lower()
                    if any(w in message for w in ['execution context was destroyed','cannot find context','inspected target navigated','uniquecontextid not found']):raise PageNavigating('页面正在跳转')
                    raise RuntimeError('浏览器操作未完成：'+method)
                return response.get('result',{})
    async def evaluate(self,expression):
        result=await self.call('Runtime.evaluate',{'expression':expression,'returnByValue':True})
        if result.get('exceptionDetails'):raise RuntimeError('页面暂未就绪')
        return result.get('result',{}).get('value')

class Page:
    async def __aenter__(self):
        self.target=None;self.socket=None
        async with httpx.AsyncClient(timeout=4) as client:version=(await client.get(BASE+'/json/version')).json()
        url=version['webSocketDebuggerUrl'];assert urlparse(url).hostname in ['127.0.0.1','localhost']
        self.browser_socket=await websockets.connect(url,max_size=6000000,open_timeout=4)
        self.browser=CDP(self.browser_socket)
        try:
            self.target=(await self.browser.call('Target.createTarget',{'url':'about:blank','background':True}))['targetId']
            receipt=os.environ.get('SHORT_MEDIA_TAB_RECEIPT')
            if receipt:Path(receipt).write_text(self.target)
            async with httpx.AsyncClient(timeout=4) as client:tabs=(await client.get(BASE+'/json/list')).json()
            endpoint=next(t['webSocketDebuggerUrl'] for t in tabs if t['id']==self.target)
            self.socket=await websockets.connect(endpoint,max_size=6000000,open_timeout=4)
            self.cdp=CDP(self.socket)
            await self.cdp.call('Page.enable');await self.cdp.call('Network.enable')
            await self.cdp.call('Emulation.setDeviceMetricsOverride',{'width':1200,'height':900,'deviceScaleFactor':1,'mobile':False})
            return self
        except BaseException:
            await self.__aexit__(None,None,None);raise
    async def __aexit__(self,*_args):
        if self.target:
            try:await asyncio.wait_for(self.browser.call('Target.closeTarget',{'targetId':self.target}),1.2)
            except (Exception,asyncio.CancelledError):pass
        if self.socket:await self.socket.close()
        await self.browser_socket.close()

async def migrate_once(page):
    source=HOME/'xhs-cookies.json';marker=HOME/'xhs-browser-imported'
    if marker.exists() or not source.exists():return
    raw=json.loads(source.read_text());cookies=raw.get('cookies',[]) if isinstance(raw,dict) else raw
    selected=[]
    for cookie in cookies:
        domain=cookie.get('domain','').lstrip('.')
        if domain!='xiaohongshu.com' and not domain.endswith('.xiaohongshu.com'):continue
        value={k:cookie[k] for k in ['name','value','domain','path','secure','httpOnly','sameSite'] if k in cookie}
        if cookie.get('expires',-1)>time.time():value['expires']=cookie['expires']
        selected.append(value)
    if selected:
        await page.cdp.call('Network.setCookies',{'cookies':selected})
        marker.write_text('scoped-cookie-imported\n');marker.chmod(0o600)

EXTRACT="""(() => {
 const text=(document.body?.innerText||'').slice(0,18000);
 const u=window.__INITIAL_STATE__?.user;
 const info=u?.userInfo?.value??u?.userInfo;
 const xhsLogin=!!document.querySelector('.main-container .user .link-wrapper .channel')||!!(info&&!info.guest&&(info.userId||info.user_id));
 const urls=[...document.querySelectorAll('a[href]')].map(a=>({url:a.href,title:(a.closest('section,article,[class*=card],[class*=item]')?.innerText||a.innerText||'').slice(0,1000)}));
 return {text,title:document.title,xhsLogin,urls};
})()"""

async def snapshot(page,platform,limit):
    value=await page.cdp.evaluate(EXTRACT) or {};text=value.get('text','')
    cookies=(await page.cdp.call('Network.getCookies',{'urls':['https://www.xiaohongshu.com/'] if platform=='xiaohongshu' else ['https://www.douyin.com/']})).get('cookies',[])
    has_session=any(c.get('name') in (['web_session'] if platform=='xiaohongshu' else ['sessionid','sessionid_ss']) and c.get('value') for c in cookies)
    visible_login=await page.cdp.evaluate("!![...document.querySelectorAll('button,[role=button]')].find(e=>e.innerText?.trim()==='登录' && e.getBoundingClientRect().width>0)")
    logged=value.get('xhsLogin',False) if platform=='xiaohongshu' else has_session and not visible_login
    allowed=[];seen=set()
    for item in value.get('urls',[]):
        u=urlparse(item.get('url',''));path=u.path
        if platform=='xiaohongshu':match=u.hostname in ['www.xiaohongshu.com','xiaohongshu.com'] and (path.startswith('/explore/') or path.startswith('/search_result/') or path.startswith('/discovery/item/'))
        else:match=u.hostname in ['www.douyin.com','douyin.com'] and path.startswith('/video/')
        if match and item['url'] not in seen:
            item['id']=path.rstrip('/').split('/')[-1]
            if platform=='xiaohongshu':item['token']=parse_qs(u.query).get('xsec_token',[''])[0]
            allowed.append(item);seen.add(item['url'])
    restricted=any(w in text.lower() for w in ['ip at risk','300012','当前网络存在风险'])
    verification=restricted or any(w in text for w in ['请完成安全验证','拖动滑块完成拼图','点击完成验证']) or any(w in value.get('title','') for w in ['验证码','安全验证','访问验证'])
    return {'logged_in':bool(logged),'needs_login':not logged,'verification_required':verification,'network_restricted':restricted,'text':text,'items':allowed[:limit]}

async def browse(request):
    platform=request['platform'];limit=request['limit']
    async with Page() as page:
        # Suppress autoplay and large media assets; retain page text and links.
        await page.cdp.call('Network.setBlockedURLs',{'urls':['*.mp4*','*.webm*','*.m3u8*','*.woff*','*.ttf*','*.jpg*','*.jpeg*','*.webp*','*.gif*']})
        if platform=='xiaohongshu':await migrate_once(page)
        await page.cdp.call('Page.navigate',{'url':page_url(request)})
        result={}
        for i in range(36):
            await asyncio.sleep(.3)
            try:result=await snapshot(page,platform,limit)
            except PageNavigating:continue
            if result['verification_required']:break
            if i>=5 and (result['items'] or result['logged_in'] or len(result['text'])>300):break
        if not result:raise RuntimeError('页面未完成加载')
        if request['action']=='status':return {k:result[k] for k in ['logged_in','needs_login','verification_required','network_restricted']}
        if not result['items'] and len(result['text'])<30:
            result['content_unavailable']=True
        return result
