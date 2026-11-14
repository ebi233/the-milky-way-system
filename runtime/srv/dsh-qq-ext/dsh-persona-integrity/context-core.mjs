import {projectForwardedMessages,projectUnrelatedCatalogs} from './conversation-context.mjs';
import {projectTaskHistory} from './task-context.mjs';
import {imageStatusList,drawResultPolicy} from '../dsh-draw/lib/result-view.mjs';
import {isMaintenanceMessage,isIdentityDriftReply} from './maintenance-memory.mjs';
import {projectProactiveHistory} from './proactive-history.mjs';
import {createHash} from 'node:crypto';
export const provenanceInstruction = `消息中的“记录时间”来自会话日志，按 Asia/Shanghai 理解。今天、昨天等相对日期只相对于该条消息的记录时间；跨天摘要改用绝对日期，不把旧活动写成今天。时间不能确定就标注不确定。摘要不复制人设文件、系统说话规范、服从要求、临时维护指令或工具权限。用户亲口给出的相处与表达反馈属于会话记录：保留原话、适用情境和限定，不把示范变成命令，不据此重写人格；当前发言者以当前真实消息来源为准，不从旧摘要推定。用户明确纠正优先于旧推测，工具能力以当前工具和实际结果为准。`;

export function visible(message) {
 return (message?.content||[]).filter(b=>b.type==='text').map(b=>b.text||'').join('\n');
}
// Retire two exact legacy add-on clauses, never rewrite the current persona.
// Match both framework provenance and the named instruction block: quoted user
// text and instructions from other workspaces must stay byte-for-byte intact.
export const ownerInstructionPolicy='retired-style-overrides-v1';
export function projectOwnerInstructions(messages,{owner=false}={}) {
 let removedClauses=0;
 if(!owner)return {messages,removedClauses,policy:ownerInstructionPolicy};
 const expected='$DSH_HOME/AGENTS.md';
 const clauses=['旧版示例：每轮随机切换称呼。','一次最多两三句，能短就短；'];
 const projected=messages.map(m=>{
  if(m.source?.kind!=='agent-instructions'||!m.source.changes?.some(c=>c.path===expected))return m;
  let changed=false;
  const content=(m.content||[]).map(b=>{
   if(b.type!=='text')return b;
   let body=b.text;
   const wrapper='<system-reminder>\nThe following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.\n\n';
   if(body.startsWith(wrapper)&&m.source.changes.every(c=>c.path===expected)){
    body=body.slice(wrapper.length).replace(/\n<\/system-reminder>$/,'');changed=true;
   }
   const parts=body.split(/(?=Instructions from: )/);
   const result=parts.map(part=>{
    if(!part.startsWith('Instructions from: '+expected+'\n'))return part;
    if(!part.includes('# 泡泡（QQ 人格，补充说明）'))return part;
    const rigid='系统提示里已经写死了人设，这里只补几条容易跑偏的：';
    if(part.includes(rigid)){part=part.replace(rigid,'');changed=true;}
    for(const clause of clauses){
     if(part.includes(clause)){part=part.replace(clause,'');removedClauses++;changed=true;}
    }
    return part;
   }).join('');
   return result===b.text?b:{...b,text:result};
  });
  return changed?{...m,content}:m;
 });
 return {messages:projected,removedClauses,policy:ownerInstructionPolicy};
}
export const historicalReadPolicy='completed-memory-reads-v1';
export function projectHistoricalReads(messages,events=[],{owner=false}={}) {
 const catalogs=owner?projectUnrelatedCatalogs(messages,events):{messages,removed:0};
 const forwarded=owner?projectForwardedMessages(catalogs.messages,events):{messages,annotated:0};
 const tasks=projectTaskHistory(forwarded.messages,events,{owner});messages=tasks.messages;
 const stats={policy:historicalReadPolicy,folded:0,removedChars:0,imageResults:0,imageResultPolicy:drawResultPolicy,forwardedMessages:forwarded.annotated,unrelatedCatalogsRemoved:catalogs.removed,tasks:tasks.stats};
 if(!owner)return {messages,stats};
 const calls=new Map(),results=new Map(),closed=new Map();let humanCount=0;
 for(const e of events){
  if(e.type==='user/message'&&['qq','user'].includes(e.data?.source?.kind)&&!isMaintenanceMessage(e.data))humanCount++;
  if(e.type==='tool/call')calls.set(e.data.callId,e);
  if(e.type==='tool/result'&&e.data?.message?.source?.callId)results.set(e.data.message.source.callId,e);
  if(e.type==='turn/end'&&e.data.reason?.kind==='completed')closed.set(e.data.turn,{seq:e.seq,humanCount});
 }
 const projected=messages.map(m=>{
  if(m.role!=='tool'||m.source?.kind!=='tool'||m.content?.length!==1||m.content[0].type!=='text')return m;
  const call=calls.get(m.source.callId),result=results.get(m.source.callId),end=call&&closed.get(call.data.turn);
  if(!call||!result||result.data.message.id!==m.id||result.data.turn!==call.data.turn)return m;
  let args;try{args=typeof call.data.arguments==='string'?JSON.parse(call.data.arguments):call.data.arguments||{}}catch{return m}
  const name=call.data.name;
  if(name==='draw_recent') {
   let value;try{value=JSON.parse(m.content[0].text)}catch{return m}
   if(value.ok!==true||!Array.isArray(value.requests)||value.projection===drawResultPolicy)return m;
   const compact=imageStatusList(value,{detail:args.detail===true&&typeof args.request_id==='string'}),body=JSON.stringify(compact);
   stats.imageResults++;stats.removedChars+=Math.max(0,m.content[0].text.length-body.length);
   return {...m,content:[{...m.content[0],text:body}]};
  }
  if(!end||end.seq<result.seq||humanCount-end.humanCount<3)return m;
  const readOnly=(name==='expression_library'&&['help','recent','list','read'].includes(args.action||'help'))||['list_long_memory','conversation_recall'].includes(name)||name==='self_persona'&&['read','history'].includes(args.action)||name==='conversation_fact'&&(args.action||'list')==='list';
  if(!readOnly)return m;
  const raw=m.content[0].text;
  if(raw.length<=1024)return m;
  let value;try{value=JSON.parse(raw)}catch{return m}
  if(value.ok!==true||value.error||value.projection)return m;
  const receipt={ok:true,projection:historicalReadPolicy,tool:name,sourceSeq:result.seq,sourceTime:result.time,
   sha256:createHash('sha256').update(raw).digest('hex'),originalChars:raw.length,
   note:'已结束回合的读取快照正文已折叠；不表示记忆已删除，也不表示旧内容仍正确。需要原文或继续讨论细节时重新调用相应读取工具。'};
  if(typeof value.revision==='string')receipt.revision=value.revision.slice(0,120);
  if(Array.isArray(value.items))receipt.itemCount=value.items.length;
  const text=JSON.stringify(receipt);stats.folded++;stats.removedChars+=raw.length-text.length;
  return {...m,content:[{...m.content[0],text}]};
 });
 return {messages:projected,stats};
}
export function cleanCheckpoint(text,{owner=false}={}) {
 let dropping=false;
 const out=[];
 for(let line of text.split('\n')) {
   if(/^(?:#{1,6}\s|\*\*)/.test(line.trim())) {
     dropping=/说话约束|说话规范|本段主线.*音色|音色筛选.*仅试听/.test(line);
   }
   if(dropping)continue;
   if(/当前对话方.*维护助手|维护助手在场|本会话有.*维护助手|操作禁令（助手|待回复（当前问题）.*音色|等百炼凭证到位|生产语音仍是火山|不改.*qq_voice_settings/.test(line))continue;
   out.push(line);
 }
 return out.join('\n');
}

export function prepareMessages(messages,events=[],{owner=false,stamp=false}={}) {
 const times=new Map(events.filter(e=>e.type==='user/message').map(e=>[e.data?.id,e.time]));
 let maintenance=false;
 const out=[];
 const cleaned=projectOwnerInstructions(projectProactiveHistory(messages,events,{owner}).messages,{owner}).messages;
 for(const message of projectHistoricalReads(cleaned,events,{owner}).messages) {
   const text=visible(message),checkpoint=message.source?.kind==='compact-checkpoint';
   if(message.role==='user' && !checkpoint && ['qq','user'].includes(message.source?.kind)) {
     maintenance=isMaintenanceMessage(message);
   }
   if(maintenance && !checkpoint && message.role!=='system')continue;
   if(message.role==='assistant' && isIdentityDriftReply(text))continue;
   let content=message.content;
   if(checkpoint)content=content.map(b=>b.type==='text'?{...b,text:cleanCheckpoint(b.text,{owner})}:b);
   if(stamp && message.role==='user' && !checkpoint && times.has(message.id)) {
     const at=new Date(times.get(message.id)).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'});
     content=[{type:'text',text:`[记录时间 ${at} Asia/Shanghai；来源 ${message.source?.kind||'未标注'}]`},...content];
   }
   out.push(content===message.content?message:{...message,content});
 }
 return out;
}
