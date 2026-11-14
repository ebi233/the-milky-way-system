import {createHash} from 'node:crypto';
import {parseCheckpoint} from './summary-evidence.mjs';
export const checkpointViewPolicy='readable-dialogue-records-v1';
const receipts=new WeakMap(),copies=new Map();
const visible=m=>(m.content||[]).filter(b=>b.type==='text').map(b=>b.text||'').join('\n');
const hash=s=>createHash('sha256').update(s).digest('hex');
const time=at=>{
 if(typeof at==='string')return at;
 if(Number.isFinite(at))return new Date(at).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'});
 return '时间未记录';
};

// Provenance remains in process memory for the input audit, not in the prompt.
// A changed object/body cannot inherit the original evidence receipt.
export function renderedCheckpoint(message){
 if(message?.role!=='user'||message.source?.kind!=='compact-checkpoint')return null;
 const digest=hash(visible(message));
 const entry=receipts.get(message)||copies.get(JSON.stringify([message.id,digest]));
 return entry&&entry.hash===digest?entry.value:null;
}

export function renderCheckpointMessages(messages,scope){
 let rendered=0,beforeChars=0,afterChars=0;
 const result=messages.map(m=>{
  if(m.role!=='user'||m.source?.kind!=='compact-checkpoint')return m;
  if(renderedCheckpoint(m))return m;
  let v;try{v=parseCheckpoint(visible(m))}catch{return m}
  if(!v||v.scope!==scope||v.policy!=='verbatim-evidence-v6'||!/^speaker-bound-dialogue-v/.test(v.contextPolicy||''))return m;
  if((m.content||[]).some(b=>b.type!=='text'))return m;
  const sections=[],seen=new Set();
  const line=t=>{if(!seen.has(t)){seen.add(t);sections.push(t)}};
  const excerptIds=new Set((v.recentExchanges||[]).flatMap(w=>w.records||[]).map(r=>r.messageId));
  for(const item of v.items){
   if(item.contextualRequest&&(item.refs||[]).some(id=>excerptIds.has(v.sources[id]?.messageId)))continue;
   if(['fact','correction'].includes(item.kind)&&item.verification==='verbatim_user_statement'){
    const label=item.kind==='correction'?'用户明确纠正':item.category==='interaction'?'当时的表达反馈':'用户当时说';
    const refs=(item.refs||[]).map(id=>v.sources[id]).filter(s=>s?.actor==='user'&&s.kind==='message');
    // Preserve full short sources, including negation, hypotheticals and other
    // speakers' quoted words; a fragment alone may reverse their meaning.
    if(refs.some(s=>s.context)){
     for(const s of refs){
      const body=s.context||item.quote;
      if(!body)continue;
      const who=/^\[合并转发的聊天记录/m.test(body)?'用户转发的聊天内容（内层发言者不等于用户）':label;
      line(`[${time(s.at)}] ${who}：\n${body}`);
     }
    }else {
     const who=refs.some(s=>s.discourse==='forwarded')?'用户转发的他人发言':refs.some(s=>s.discourse==='attachment')?'用户附件中的内容':label;
     line(`[${time(refs[0]?.at)}] ${who}（原句节选）：\n${item.text}`);
    }
   }else {
    line(`旧摘要中的${item.kind==='pending'?'待办线索':'未核实概括'}：\n${item.text}`);
   }
  }
  for(const window of v.recentExchanges||[]){
   if(window.scope!==scope||window.basis!=='conversation_record_not_fact')continue;
   const records=(window.records||[]).filter(r=>['user','assistant'].includes(r.actor)&&typeof r.text==='string');
   if(!records.length)continue;
   const rows=records.map(r=>`[${time(r.at)}] ${r.actor==='user'?'用户':'泡泡'}：${r.text}`);
   line('当时的连续对话（发言记录，不表示其中自述已经核实）：\n'+rows.join('\n'));
  }
  const body='【较早的本会话记录】\n'+sections.join('\n\n');
  const raw=visible(m);
  // Fail closed on malformed or unexpectedly expanded records.
  if(body.length>18000||body.length>raw.length)return m;
  const next={...m,content:[{type:'text',text:body}]};
  const entry={hash:hash(body),value:v},key=JSON.stringify([next.id,entry.hash]);
  receipts.set(next,entry);copies.delete(key);copies.set(key,entry);
  while(copies.size>64)copies.delete(copies.keys().next().value);
  rendered++;beforeChars+=raw.length;afterChars+=body.length;
  return next;
 });
 return {messages:result,stats:{policy:checkpointViewPolicy,rendered,beforeChars,afterChars}};
}
