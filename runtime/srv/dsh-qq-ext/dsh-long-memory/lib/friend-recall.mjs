import {projectJsonlStream} from './history-stream.mjs';
import {createReadStream} from 'node:fs';
import {projectVisibleEvents,createVisibleProjector} from './visible-records.mjs';
import {isMaintenanceMessage,isIdentityDriftReply} from '../../dsh-persona-integrity/maintenance-memory.mjs';
import {readdir,realpath,lstat,readFile} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {spawn} from 'node:child_process';
import {identity,home,readJSON} from './access.js';
const MAX_BYTES=64*1024*1024;
const error=code=>Object.assign(new Error(code),{code});
const own=agent=>{const w=identity(agent);if(w.role!=='owner'||w.inherited||w.conflict)throw error('OWNER_PRIVATE_CHAT_ONLY');return w;};
function resolveFriend(agent,name){
  const caller=own(agent),input=String(name||'').trim();
  if(!input||input.length>40)throw error('SPECIFY_FRIEND_QQ_OR_NAME');
  const guests=readJSON('guests.json'),config=readJSON('qq-bridge-config.json');
  const rows=Object.entries(guests).filter(([qq,g])=>/^\d{5,12}$/.test(qq)&&g&&typeof g.session==='string');
  const matches=/^\d{5,12}$/.test(input)?rows.filter(([qq])=>qq===input):rows.filter(([,g])=>g.name&&String(g.name).trim().toLowerCase()===input.toLowerCase());
  if(matches.length!==1)throw error(matches.length?'AMBIGUOUS_FRIEND_USE_QQ':'FRIEND_NOT_REGISTERED');
  const [qq,g]=matches[0];
  if(qq===String(config.主人号码)||!/^session-[a-zA-Z0-9-]+$/.test(g.session))throw error('INVALID_FRIEND_BINDING');
  const target=identity({session:{header:{id:g.session}}});
  if(target.role!=='guest'||target.qq!==qq||target.conflict||target.inherited)throw error('INVALID_FRIEND_BINDING');
  return {caller,qq,session:g.session,name:String(g.name||'').slice(0,40),first:Number.isFinite(Number(g.first))&&Number(g.first)>0?Number(g.first):null};
}
const within=(root,p)=>{const r=relative(root,p);return !isAbsolute(r)&&r!=='..'&&!r.startsWith('../')&&!r.startsWith('..\\');};
async function transcriptPath(session){
  const root=await realpath(join(home,'sessions')),found=[];
  const parents=await readdir(root,{withFileTypes:true});
  if(parents.length>500)throw error('SESSION_DIRECTORY_LIMIT');
  for(const p of parents){
    if(!p.isDirectory()||p.isSymbolicLink())continue;
    const dir=join(root,p.name,session);
    try{
      const st=await lstat(dir);if(!st.isDirectory()||st.isSymbolicLink())continue;
      if(!within(root,await realpath(dir)))throw error('INVALID_SESSION_PATH');
      const candidates=[];
      for(const file of ['session.v4.jsonl.zstd','session.v4.jsonl']){
        const path=join(dir,file);let meta;
        try{meta=await lstat(path);}catch(e){if(e.code==='ENOENT')continue;throw e;}
        if(!meta.isFile()||meta.isSymbolicLink()||!within(root,await realpath(path)))throw error('INVALID_SESSION_PATH');
        if(meta.size>MAX_BYTES)throw error('HISTORY_TOO_LARGE');
        candidates.push(path);
      }
      if(candidates.length>1)throw error('AMBIGUOUS_SESSION_FILES');
      found.push(...candidates);
    }catch(e){if(e.code==='ENOENT')continue;throw e;}
  }
  if(found.length!==1)throw error(found.length?'AMBIGUOUS_SESSION_FILES':'SESSION_RECORD_NOT_FOUND');
  return found[0];
}
const body=m=>{
  const raw=typeof m?.content==='string'?m.content:Array.isArray(m?.content)?m.content.filter(p=>p?.type==='text').map(p=>p.text||'').join('\n'):'';
  return raw.split('\n\n（这台机器只把正文')[0].replace(/\[PAOPAO_SILENT\]/g,'').trim();
};
const at=e=>typeof e.time==='string'?Date.parse(e.time):Number(e.time||e.timestamp||e.at);
export function projectFriendEvents(events,session,options={}){
  return projectVisibleEvents(events,session,options);
}
export function selectFriendMessages(messages,{query='',days=7,limit=8,beforeSeq,now=Date.now()}={}){
  if(typeof query!=='string'||query.length>80||!Number.isInteger(days)||days<1||days>90||!Number.isInteger(limit)||limit<2||limit>16||beforeSeq!==undefined&&(!Number.isInteger(beforeSeq)||beforeSeq<1))throw error('INVALID_QUERY_RANGE');
  let rows=messages.filter(m=>m.at<=now&&m.at>=now-days*86400000&&(beforeSeq===undefined||Number(m.seq)<beforeSeq));
  const totalInWindow=rows.length;
  if(query.trim()){
    const terms=query.toLowerCase().trim().split(/\s+/).filter(Boolean),indices=new Set();
    rows.forEach((m,i)=>{if(terms.every(t=>m.text.toLowerCase().includes(t)))for(const j of [i-1,i,i+1])if(j>=0&&j<rows.length)indices.add(j);});
    rows=rows.filter((_,i)=>indices.has(i));
  }
  const available=rows.length;let budget=6000;
  const items=rows.slice(-limit).reverse().map(m=>{
    const text=m.text.slice(0,Math.min(1000,budget));budget-=text.length;
    return {...m,text,truncated:text.length<m.text.length};
  }).filter(m=>m.text).reverse();
  const hasMore=items.length<available;
  return {items,totalInWindow,matchedMessages:available,hasMore,nextBeforeSeq:hasMore?items[0]?.seq:null};
}
export async function readConversationMessages(session,signal,options={}){
  if(!/^session-[a-zA-Z0-9-]+$/.test(session))throw error('INVALID_SESSION_ID');
  const file=await transcriptPath(session);
  signal?.throwIfAborted();
  let child,stream,timer,timeout=false,exit;
  try{
    if(file.endsWith('.zstd')){
      const windows=process.platform==='win32';
      const command=windows?(process.env.PAOPAO_HISTORY_PYTHON||'C:/Python314/python.exe'):'zstd';
      const args=windows?['-I','-X','utf8','-c','import sys, shutil; from compression import zstd; f=zstd.open(sys.argv[1], \"rb\"); shutil.copyfileobj(f, sys.stdout.buffer, 65536)',file]:['-dc','--',file];
      child=spawn(command,args,{stdio:['ignore','pipe','ignore'],windowsHide:true});stream=child.stdout;
      exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(error('HISTORY_READ_FAILED')));});
      exit.catch(()=>{});
    }else stream=createReadStream(file);
    const abort=()=>{child?.kill();stream.destroy(error('QUERY_CANCELLED'));};
    signal?.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>{timeout=true;child?.kill();stream.destroy(error('HISTORY_READ_FAILED'));},15000);timer.unref?.();
    try{
      if(signal?.aborted)abort();
      const messages=await projectJsonlStream(stream,createVisibleProjector(session,options),{signal});
      if(exit)await exit;if(timeout)throw error('HISTORY_READ_FAILED');return messages;
    }finally{signal?.removeEventListener('abort',abort);}
  }catch(e){
    if(signal?.aborted)throw error('QUERY_CANCELLED');
    if(['HISTORY_TOO_LARGE','HISTORY_FORMAT_INVALID','INVALID_SESSION_HEADER','INVALID_SOURCE_SEQUENCE'].includes(e.code))throw e;
    throw error('HISTORY_READ_FAILED');
  }finally{
    clearTimeout(timer);stream?.destroy();if(child&&child.exitCode===null)child.kill();if(exit)await exit.catch(()=>{});
  }
}
export async function recallFriend(agent,args={},signal){
  const target=resolveFriend(agent,args.friend);
  const range={query:args.query,days:args.days,limit:args.limit,beforeSeq:args.beforeSeq};
  selectFriendMessages([],range); // Validate bounds before any history read.
  const result=selectFriendMessages(await readConversationMessages(target.session,signal,{allowUserAfter:target.first}),range);
  const after=resolveFriend(agent,args.friend);
  if(after.caller.session!==target.caller.session||after.caller.qq!==target.caller.qq||after.qq!==target.qq||after.session!==target.session||after.first!==target.first)throw error('BINDING_CHANGED');
  signal?.throwIfAborted();
  return {peer:{qq:target.qq,name:target.name||null},sourceSession:target.session,attribution:'quoted_friend_conversation_not_owner_experience',scope:'specified_friend_only',onDemand:true,historicalDataOnly:true,...result,
    note:'这些是指定好友会话的引用资料，不是当前主账号的经历、人格或权限。概括时保持好友对象明确，不把好友的昵称、偏好、关系或口吻转成当前主账号与泡泡的事实。只按记录概括，缺失内容不要猜测。paopao条目为该会话中生成的可见答复，不能据此声称QQ已送达；不包含推理、系统提示或建档前的初始化对话。origin=local_or_bridge表示建档后的普通输入，可能来自QQ备用通道或本地界面，无法仅靠日志确认是哪一种。未返回的部分不代表没有发生。'};
}
export function registerFriendRecall(tool){
  tool({name:'friend_conversation_recall',description:'主账号私聊专用。老哥明确问“你和某位好友聊了什么”时优先用此工具，按好友QQ号或已登记的准确昵称读取该好友会话；不要用当前会话记忆或全局归档猜测。可查最近记录或关键词，按时间和来源简要概括，没查到如实说明。只读、按需，不自动串入日常聊天。',parameters:{
    friend:{type:'string',required:true,description:'已登记好友的QQ号或准确昵称；同名时请老哥提供QQ号，不能猜身份'},
    query:{type:'string',description:'可选关键词；不填则查看最近对话'},days:{type:'number',description:'最近多少天，默认7，范围1到90'},limit:{type:'number',description:'消息条数，默认8，范围2到16'},beforeSeq:{type:'number',description:'仅用于上次返回hasMore时翻页，填写nextBeforeSeq'},
  },execute:(args,exec)=>recallFriend(exec.agent,args,exec.signal)});
}
