export async function readPublicBili(bvid,signal,{fetcher=fetch}={}) {
  if(typeof bvid!=='string'||!/^BV[0-9A-Za-z]{10}$/.test(bvid))return {ok:false,code:'INVALID_BVID'};
  signal?.throwIfAborted();const controller=new AbortController();
  const abort=()=>controller.abort(signal.reason);signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(),8000);
  try {
    if(signal?.aborted)abort();
    const r=await fetcher('https://api.bilibili.com/x/web-interface/view?bvid='+encodeURIComponent(bvid),{signal:controller.signal,redirect:'error',headers:{Accept:'application/json'}});
    if(!r.ok)return {ok:false,code:'PUBLIC_SOURCE_UNAVAILABLE'};
    const reader=r.body.getReader();let size=0;const chunks=[];
    try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1024*1024){await reader.cancel();return {ok:false,code:'RESULT_LIMIT'};}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(value.code!==0||!value.data)return {ok:false,code:'PUBLIC_SOURCE_UNAVAILABLE'};
    const d=value.data;
    return {ok:true,bvid,url:'https://www.bilibili.com/video/'+bvid,title:String(d.title||'').slice(0,300),description:String(d.desc||'').slice(0,5000),creator:String(d.owner?.name||'').slice(0,100),durationSeconds:Number(d.duration)||0,publishedAt:Number(d.pubdate)||0,statistics:{views:Number(d.stat?.view)||0,likes:Number(d.stat?.like)||0},videoWatched:false,transcriptAvailable:false,untrustedPublicData:true};
  }catch{return {ok:false,code:signal?.aborted?'CANCELLED':'PUBLIC_SOURCE_UNAVAILABLE'};}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
}
