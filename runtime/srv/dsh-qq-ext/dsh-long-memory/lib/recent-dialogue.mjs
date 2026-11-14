import {projectVisibleEvents} from './visible-records.mjs';
import {identity,readJSON} from './access.js';

export const recentDialoguePolicy='current-dialogue-before-archive-v1';
const binding=w=>JSON.stringify([w.role,w.session,w.qq,w.group,!!w.inherited,!!w.conflict]);
// Only bare deictic queries, not a topic containing one of these words.
export function isRecentQuery(query){
  const q=String(query??'').trim().replace(/[，。！？!?~～\s]+$/u,'');
  return /^(?:刚才|刚刚|刚才说的|刚刚说的|上一句|上句话|你又忘啦|你又忘了|忘|忘了)$/.test(q);
}
export function selectRecentDialogue(events,session,{now=Date.now(),limit=4,projection={}}={}){
  if(!/^session-[a-zA-Z0-9-]+$/.test(session)||!Number.isFinite(now)||!Number.isInteger(limit)||limit<1||limit>6)throw Error('Invalid recent-dialogue bounds');
  if(!Array.isArray(events))throw Error('Current dialogue is unavailable');
  const input=events[0]?.type==='session'?events:[{type:'session',version:4,id:session},...events];
  const rows=projectVisibleEvents(input,session,projection).filter(m=>m.at<=now&&m.at>=now-2*60*60*1000);
  // Select complete neighbouring human turns, never search unrelated history.
  const turns=[...new Set(rows.filter(m=>m.role==='friend').map(m=>m.turn))].slice(-limit);
  const eligible=rows.filter(m=>turns.includes(m.turn));
  let budget=6000;
  const items=[];
  for(const m of eligible.slice(-12).reverse()){
    if(!budget)break;
    const text=m.text.slice(0,Math.min(1600,budget));budget-=text.length;
    items.push({role:m.role==='friend'?'user':'assistant',text,at:m.at,sourceSession:session,sourceSeq:m.seq,messageId:m.messageId,
      evidenceBasis:m.role==='friend'?'user_record':'assistant_statement',delivery:m.delivery,truncated:text.length<m.text.length});
  }
  items.reverse();
  return {mode:'recent',policy:recentDialoguePolicy,scope:'current_conversation',sourceSession:session,items,count:items.length,
    chronological:true,windowHours:2,maxHumanTurns:limit,archiveSearched:false,onDemand:true,
    truncated:items.length<eligible.length||items.some(m=>m.truncated),
    note:items.length?'以下是当前会话最近两小时内的连续原话，按时间排列；用于核对刚才的指代，不是旧事搜索结果。assistant 只是当时的回答，不证明其中的说法正确。':'当前已加载记录没有可核对的近期原话；没有转而搜索旧档案，不能据此猜测刚才发生过什么。'};
}
export function readRecentDialogue(agent,{now=Date.now(),limit=4,signal}={}){
  signal?.throwIfAborted();
  const who=identity(agent);
  if(who.inherited||who.conflict||!['owner','guest','group'].includes(who.role))throw Error('Only a directly bound conversation may read its current dialogue');
  let allowUserAfter=0;
  if(who.role==='guest')allowUserAfter=Number(readJSON('guests.json')[who.qq]?.first);
  if(who.role==='group'){
    const at=readJSON('group-session-seals.json').sessions?.[who.session]?.sealedAt;
    allowUserAfter=typeof at==='string'?Date.parse(at):Number(at);
  }
  const result=selectRecentDialogue(agent?.session?.snapshotEvents?.(),who.session,{now,limit,projection:{allowUserAfter,skipFirstUserTurn:who.role==='owner'}});
  signal?.throwIfAborted();
  if(binding(identity(agent))!==binding(who))throw Error('Conversation binding changed during recent dialogue read');
  return result;
}
