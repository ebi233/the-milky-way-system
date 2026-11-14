// Adapter to the already-installed ywleeo/browser-mcp relay. No browser engine,
// platform login, or general browsing permissions are implemented here.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {safePublicText,canonicalSource} from './social-policy.mjs';

export function browserItems(platform,response){
  if(response?.ok!==true)throw Error(['local_browser_offline','extension_required','timeout','busy','cooldown'].includes(response?.error)?response.error:'browser_unavailable');
  const result=response.result;
  if(result?.verification_required)throw Error('verification_required');
  if(result?.needs_login)throw Error('login_required');
  if(result?.available!==true||!Array.isArray(result.items))throw Error('no_rendered_results');
  // Only public item titles and canonical item URLs leave the browser layer.
  // Drop account fields, tokens, page body, comments and personalized feed text.
  return result.items.slice(0,5).flatMap(item=>{
    const id=platform+':'+String(item?.id||'');
    const url=canonicalSource(id);
    if(!url||!safePublicText(item?.title,300))return [];
    try{
      const actual=new URL(item.url),expected=new URL(url);
      const paths=platform==='xiaohongshu'?['/explore/','/search_result/','/discovery/item/']:['/video/'];
      if(actual.protocol!=='https:'||actual.username||actual.password||actual.port||actual.hostname!==expected.hostname||!paths.some(p=>actual.pathname===p+item.id))return [];
    }catch{return []}
    return [{id,platform,title:item.title,description:'',url,videoWatched:false,evidence:'rendered_public_item_title_only'}];
  });
}

export async function browseBrowser(home,platform,signal,cycle=0){
  if(!['xiaohongshu','douyin'].includes(platform))throw Error('INVALID_PLATFORM');
  const interests=['海洋生物','自然科普','游戏趣闻','日常美食'];
  const args=platform==='douyin'?{platform,action:'search',keyword:interests[cycle%interests.length],limit:3}:{platform,action:'feed',limit:3};
  let config;try{config=JSON.parse(readFileSync(join(home,'short-media/config.json'),'utf8'))}catch{throw Error('browser_unavailable')}
  if(config.transport==='browser_cdp')return browserItems(platform,await readServerBrowser(args,signal));
  if(config.transport!=='local_browser_relay')throw Error('browser_unavailable');
  let key;try{key=readFileSync(join(home,'short-media/local-relay-key'),'utf8').trim()}catch{throw Error('local_browser_offline')}
  let response;
  try{response=await fetch('http://127.0.0.1:18081/browse',{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer '+key},body:JSON.stringify(args),signal:AbortSignal.any([signal,AbortSignal.timeout(35000)])})}
  catch{throw Error(signal.aborted?'timeout':'local_browser_offline')}
  if(!response.ok)throw Error('browser_unavailable');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>60000){await reader.cancel();throw Error('browser_result_limit')}chunks.push(Buffer.from(value))}}
  finally{reader.releaseLock()}
  return browserItems(platform,JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

// Reuse the installed supervised CDP reader and its cancellation/tab cleanup.
// There is no fallback between local/cloud transports and no arbitrary command.
export async function readServerBrowser(args,signal,launch=spawn){
  signal.throwIfAborted();
  return await new Promise((resolve,reject)=>{
    const root='/srv/dsh-qq-ext/dsh-short-media';
    const child=launch('/usr/bin/python3',[root+'/supervise.py','read','/srv/dsh-cloud/opt/short-media/douyin-venv/bin/python',root+'/adapter.py'],{stdio:['pipe','pipe','pipe']});
    let output='',bytes=0,timedOut=false;
    const stop=()=>child.kill('SIGTERM');
    const timer=setTimeout(()=>{timedOut=true;stop()},35000);
    const clean=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop)};
    signal.addEventListener('abort',stop,{once:true});
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>60000){timedOut=true;stop()}else output+=chunk});
    child.stderr.on('data',()=>{});
    child.on('error',()=>{clean();reject(Error('browser_unavailable'))});
    child.on('close',()=>{
      clean();
      if(timedOut||signal.aborted){reject(Error('timeout'));return}
      try{
        const r=JSON.parse(output.trim());
        if(r.ok===true&&r.result){
          r.result.available=Array.isArray(r.result.items)&&r.result.items.length>0;
          r.result.items=(r.result.items||[]).map(v=>({...v,title:String(v.title||'').slice(0,200)}));
        }
        resolve(r);
      }catch{reject(Error('browser_unavailable'))}
    });
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(args));if(signal.aborted)stop();
  });
}
