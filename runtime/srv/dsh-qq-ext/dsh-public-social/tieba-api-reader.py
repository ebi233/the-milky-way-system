"""aiotieba 4.8.4 codecs with a bounded, anonymous, HTTPS-only read transport.

Only the two public read endpoints are exposed. No login, writes, cookies,
WebSocket initialization, profile lookup or default insecure TLS transport.
"""
import asyncio,json,logging,re,sys
from types import SimpleNamespace

MAX_BYTES=1024*1024
class ReadError(Exception):pass

def select_thread(threads,forum,seen):
    if threads.forum.fname!=forum:raise ReadError('source_mismatch')
    for t in list(threads)[:15]:
        if not isinstance(t.tid,int) or not re.fullmatch(r'[1-9][0-9]{4,19}',str(t.tid)):continue
        if t.is_top or t.is_hide or t.reply_num<1 or 'tieba:'+str(t.tid) in seen:continue
        return t.tid
    raise ReadError('no_new_public_material')

def project_posts(posts,forum,tid):
    if posts.forum.fname!=forum or posts.thread.tid!=tid:raise ReadError('source_mismatch')
    title=posts.thread.title
    if not isinstance(title,str) or not 1<=len(title)<=300:raise ReadError('filtered')
    texts=[];ids=set()
    for p in list(posts)[:24]:
        if p.tid!=tid or not isinstance(p.pid,int) or p.pid<=0 or p.pid in ids:raise ReadError('source_mismatch')
        ids.add(p.pid);text=p.text
        if not isinstance(text,str) or len(text)>600:raise ReadError('filtered')
        if text.strip():texts.append(text.strip())
    if not texts:raise ReadError('no_rendered_results')
    return {'status':'read','id':'tieba:'+str(tid),'forum':forum,'title':title,'posts':texts,'pageScope':'first_page_only','reader':'aiotieba-4.8.4'}

class ReadTransport:
    def __init__(self,session):self.session=session;self.net_core=self;self.account=SimpleNamespace(BDUSS='');self.requests=0
    def pack_proto_request(self,url,data):
        if url.host!='tiebac.baidu.com' or url.user or url.password or url.path not in ('/c/f/frs/page','/c/f/pb/page'):raise ReadError('invalid_source')
        return str(url.with_scheme('https').with_port(None)),data
    async def send(self,request):
        import aiohttp
        self.requests+=1
        if self.requests>2:raise ReadError('request_limit')
        url,data=request
        with aiohttp.MultipartWriter('form-data',boundary='-*_r1999') as writer:
            part=writer.append(data);part.set_content_disposition('form-data',name='data',filename='file');part.headers.pop('Content-Type',None)
            async with self.session.post(url,data=writer,allow_redirects=False,ssl=True) as response:
                if response.status in (301,302,303,307,308,401,403,429):raise ReadError('platform_restricted')
                if response.status!=200:raise ReadError('read_failed')
                chunks=[];total=0
                async for chunk in response.content.iter_chunked(16384):
                    total+=len(chunk)
                    if total>MAX_BYTES:raise ReadError('result_limit')
                    chunks.append(chunk)
                return b''.join(chunks)

def resolve_forum(threads,requested):
    name=threads.forum.fname;fid=threads.forum.fid
    if not isinstance(name,str) or not 1<=len(name)<=24 or not re.fullmatch(r'[\w ·-]+',name) or not isinstance(fid,int) or isinstance(fid,bool) or fid<=0:raise ReadError('source_mismatch')
    return name,fid

def project_resolved(posts,requested,canonical,fid,tid):
    if getattr(posts.forum,'fid',None)!=fid:raise ReadError('source_mismatch')
    result=project_posts(posts,canonical,tid)
    return {**result,'forum':requested,'resolvedForum':canonical,'forumId':fid}

async def read_forum(forum,seen):
    if not isinstance(forum,str) or not 1<=len(forum)<=24 or not re.fullmatch(r'[\w ·-]+',forum) or not isinstance(seen,list) or len(seen)>200:raise ReadError('invalid_source')
    import aiohttp,aiotieba
    from aiotieba.api.get_threads import _api as threads_api
    from aiotieba.api.get_posts import _api as posts_api
    from aiotieba.const import LEGACY_VERSION
    if aiotieba.__version__!='4.8.4':raise ReadError('dependency_version')
    logging.disable(logging.CRITICAL)
    async with asyncio.timeout(16):
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=7,connect=3),trust_env=False,cookie_jar=aiohttp.DummyCookieJar(),headers={'User-Agent':'aiotieba/4.8.4 XinghePublicReader/0.1','x_bd_data_type':'protobuf'}) as session:
            core=ReadTransport(session)
            threads=await threads_api.request_http(core,forum,1,10,1,False,LEGACY_VERSION)
            canonical,fid=resolve_forum(threads,forum)
            tid=select_thread(threads,canonical,seen)
            posts=await posts_api.request_http(core,tid,1,20,0,False,False,True,0)
            return project_resolved(posts,forum,canonical,fid,tid)

def main():
    try:
        req=json.loads(sys.argv[1]);result=asyncio.run(read_forum(req['forum'],req.get('seen',[])))
    except ReadError as e:result={'status':str(e)}
    except (TimeoutError,asyncio.TimeoutError):result={'status':'timeout'}
    except ImportError:result={'status':'dependency_unavailable'}
    except Exception as e:
        result={'status':'platform_restricted' if type(e).__name__=='TiebaServerError' else 'read_failed'}
    print(json.dumps(result,ensure_ascii=True))
if __name__=='__main__':main()
