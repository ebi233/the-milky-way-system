import fs from 'node:fs';

import path from 'node:path';

import {isMaintenanceMessage} from './maintenance-memory.mjs';

export const taskContextPolicy='closed-task-exchanges-ephemeral-v1';

const human=m=>['qq','user'].includes(m?.source?.kind)&&!isMaintenanceMessage(m);

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

const chars=m=>(m.content||[]).filter(b=>b.type==='text').reduce((n,b)=>n+(b.text||'').length,0);



// Remove whole matched protocol exchanges, never an isolated result or part of

// an assistant message carrying visible speech. Durable tool history is retained.

export function projectTaskHistory(messages,events=[],{owner=false}={}) {

 const stats={policy:taskContextPolicy,removedToolPairs:0,removedMessages:0,removedChars:0,removedMaintenanceMessages:0};

 if(!owner)return {messages,stats};

 const turns=new Map(),calls=new Map(),results=new Map(),records=new Map();let turn=null,humans=0;

 for(const e of events){

  const d=e.data||{};

  if(e.type==='turn/start'){turn={number:d.turn,complete:false,human:false,maintenance:false};turns.set(d.turn,turn);}

  if(e.type==='user/message'){

   if(human(d)){humans++;if(turn)turn.human=true;}

   if(turn&&isMaintenanceMessage(d))turn.maintenance=true;

   records.set(d.id,{message:d,turn,seq:e.seq});

  }

  if(e.type==='assistant/message')records.set(d.message?.id,{message:d.message,turn,seq:e.seq});

  if(e.type==='tool/call')calls.set(d.callId,d);

  if(e.type==='tool/result'){results.set(d.message?.source?.callId,{...d,seq:e.seq});records.set(d.message?.id,{message:d.message,turn,seq:e.seq});}

  if(e.type==='turn/end'){

   const t=turns.get(d.turn);if(t){t.complete=d.reason?.kind==='completed';t.end=e.seq;t.humansAtEnd=humans;}turn=null;

  }

 }

 const byId=new Map(messages.map(m=>[m.id,m])),drop=new Set(),eligibleTurns=new Set();

 for(const t of turns.values())if(t.complete&&humans-t.humansAtEnd>=3)eligibleTurns.add(t.number);

 // Maintenance-only closed turns never become a template for personal replies.

 // Require the complete visible protocol bundle to be present and unchanged.

 for(const t of turns.values()){

  if(!t.complete||!t.maintenance||t.human)continue;

  const rs=[...records.values()].filter(r=>r.turn===t),ms=rs.map(r=>byId.get(r.message.id));

  if(!ms.length||ms.some((m,i)=>!m||!same(m.content,rs[i].message.content)))continue;

  if(ms.some(m=>(m.content||[]).some(b=>!['text','reasoning','tool-call'].includes(b.type))))continue;

  for(const m of ms){drop.add(m.id);stats.removedMaintenanceMessages++;}

 }

 for(const m of messages){

  if(m.role!=='assistant'||drop.has(m.id))continue;

  const r=records.get(m.id),t=r?.turn;

  if(!t||!eligibleTurns.has(t.number)||r.message?.role!=='assistant'||!same(m.content,r.message.content))continue;

  const blocks=m.content||[],tc=blocks.filter(b=>b.type==='tool-call');

  if(!tc.length||blocks.some(b=>!['reasoning','tool-call'].includes(b.type)))continue;

  const paired=tc.map(b=>{

   const c=calls.get(b.id),result=results.get(b.id),rm=result&&byId.get(result.message.id);

   if(!c||c.turn!==t.number||c.name!==b.name||!result||result.turn!==t.number||result.seq>t.end||!rm)return null;

   let args;try{args=typeof c.arguments==='string'?JSON.parse(c.arguments):c.arguments||{}}catch{return null}

   const readOnlyWeb=['web_fetch','web_search'].includes(c.name);

   const disposable=readOnlyWeb||['imagegen_skill','draw_recent','draw_image','list_long_memory','conversation_recall','expression_library'].includes(c.name)

     ||c.name==='conversation_fact'&&['list','save','delete'].includes(args.action||'list')

     ||c.name==='self_persona'&&['read','history'].includes(args.action)

     ||c.name==='subagent'&&args.run_in_background===false;

   // Unknown/async tools may still own background work after a chat turn ends.

   if(!disposable)return null;

   if(rm.role!=='tool'||rm.source?.kind!=='tool'||rm.source.callId!==b.id||!same(rm.content,result.message.content))return null;

   if((rm.isError&&!readOnlyWeb)||!rm.content?.length||rm.content.some(x=>x.type!=='text'))return null;

   try{if(!readOnlyWeb&&JSON.parse(rm.content[0].text)?.ok===false)return null;}catch{}

   return rm;

  });

  if(paired.some(x=>!x))continue;

  drop.add(m.id);for(const rm of paired)drop.add(rm.id);stats.removedToolPairs+=tc.length;

 }

 const kept=messages.filter(m=>{if(!drop.has(m.id))return true;stats.removedMessages++;stats.removedChars+=chars(m);return false});

 return {messages:stats.removedMessages?kept:messages,stats};

}



// Volatile queue state belongs to the existing external queue, not a repeated

// conversational promise. Only exact, owner-bound image job IDs are eligible;

// ordinary promises, user quotations, missing jobs and foreign sessions survive.

export function externalTaskItems(items,scope,home=process.env.DSH_HOME||'/srv/dsh-cloud/home') {

 let binding;try{const c=JSON.parse(fs.readFileSync(path.join(home,'qq-bridge-config.json'),'utf8'));

  binding=c.绑定?.find(r=>r.类型==='私聊'&&String(r.号码)===String(c.主人号码)&&r.会话===scope);

  if(!binding)return items;

 }catch{return items}

 return items.filter(item=>{

  if(item.kind!=='pending'||item.quote||item.pinned||!/生图|自拍.*任务/.test(item.text||''))return true;

  const ids=[...new Set((item.text||'').match(/\b[a-f0-9]{32}\b/g)||[])];

  if(!ids.length)return true;

  return !ids.every(id=>{try{

   const job=JSON.parse(fs.readFileSync(path.join(home,'image-handoff',id+'.json'),'utf8'));

   return job.id===id&&job.session===scope&&String(job.ownerQQ)===String(binding.号码)&&typeof job.status==='string';

  }catch{return false}});

 });

}

