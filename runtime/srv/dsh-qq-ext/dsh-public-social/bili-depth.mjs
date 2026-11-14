import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {safePublicText} from './social-policy.mjs';

const codes=new Set(['read','empty','no_subtitle','login_required','platform_restricted','timeout','read_failed','result_limit','unavailable','filtered']);
const status=v=>codes.has(v)?v:'unavailable';
export function normalizeDepth(raw,bvid){
  if(raw?.bvid!==bvid)throw Error('INVALID_DEPTH_SOURCE');
  const t=raw.subtitle||{},c=raw.comments||{};
  const text=typeof t.text==='string'?t.text.slice(0,1800):'';
  const valid=t.status==='read'&&safePublicText(text,1800);
  const snippets=c.status==='read'&&Array.isArray(c.snippets)?c.snippets.slice(0,3).filter(s=>safePublicText(s,120)):[];
  const subtitle={status:valid?'read':t.status==='read'?'filtered':status(t.status),text:valid?text:'',truncated:!!t.truncated,scope:'first_part'};
  const comments={status:snippets.length?'read':c.status==='read'?'filtered':status(c.status),snippets};
  return {subtitle,comments,evidence:valid?'public_subtitle_excerpt':snippets.length?'public_description_and_comments':'public_title_description_only',videoWatched:false};
}
export async function readBiliDepth(home,bvid,signal,{runner=execFile,timeoutMs=22000}={}){
  if(!/^BV[0-9A-Za-z]{10}$/.test(bvid||''))throw Error('INVALID_BVID');
  signal?.throwIfAborted();
  try{
    const raw=await new Promise((resolve,reject)=>runner(join(home,'bili-duty/.venv/bin/python'),[fileURLToPath(new URL('./bili-reader.py',import.meta.url)),home,bvid],
      {timeout:timeoutMs,killSignal:'SIGKILL',signal,maxBuffer:256*1024,windowsHide:true,encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:home,PYTHONIOENCODING:'utf-8'}},
      (err,out)=>err?reject(err):resolve(out)));
    signal?.throwIfAborted();return normalizeDepth(JSON.parse(raw),bvid);
  }catch(e){
    signal?.throwIfAborted();
    return normalizeDepth({bvid,subtitle:{status:e.killed?'timeout':'unavailable'},comments:{status:e.killed?'timeout':'unavailable'}},bvid);
  }
}
