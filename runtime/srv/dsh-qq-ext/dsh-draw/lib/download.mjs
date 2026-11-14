import {setTimeout as sleep} from 'node:timers/promises';

export async function downloadImage(url,{signal,timeoutMs=55000,maxBytes=8*1024*1024,fetcher=fetch}={}){
  const controller=new AbortController();
  const forward=()=>controller.abort(signal.reason);
  signal?.addEventListener('abort',forward,{once:true});
  if(signal?.aborted)forward();
  const timer=setTimeout(()=>controller.abort(new Error('出图等待超过 55 秒，已取消')),timeoutMs);
  const active=controller.signal;
  try{
    for(let attempt=0;attempt<2;attempt++){
      active.throwIfAborted();
      const res=await fetcher(url,{signal:active});
      if(!res.ok){
        await res.body?.cancel();
        if(attempt===0&&[429,502,503,504].includes(res.status)){
          const delay=Number(res.headers.get('retry-after')||'1');
          if(Number.isFinite(delay)&&delay>=0&&delay<=2){await sleep(Math.max(1000,delay*1000),undefined,{signal:active});continue;}
        }
        throw new Error(`出图服务 HTTP ${res.status}，本次停止，不持续等待额度`);
      }
      const type=res.headers.get('content-type')||'';
      if(!type.startsWith('image/')||Number(res.headers.get('content-length')||0)>maxBytes){
        await res.body?.cancel();throw new Error('图片类型不正确或超过 8 MiB 限制');
      }
      if(!res.body)throw new Error('出图服务返回空内容');
      const reader=res.body.getReader(),chunks=[];let bytes=0;
      const cancel=()=>{void reader.cancel(active.reason).catch(()=>{});};
      active.addEventListener('abort',cancel,{once:true});
      try{
        while(true){
          active.throwIfAborted();
          const {value,done}=await reader.read();active.throwIfAborted();
          if(done)break;
          bytes+=value.byteLength;
          if(bytes>maxBytes)throw new Error('图片超过 8 MiB 限制');
          chunks.push(Buffer.from(value));
        }
      }finally{active.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});reader.releaseLock();}
      active.throwIfAborted();
      if(bytes<1024)throw new Error('返回的图片太小，可能生成失败');
      return {buf:Buffer.concat(chunks,bytes),type};
    }
    throw new Error('出图重试次数已用完');
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',forward);}
}
