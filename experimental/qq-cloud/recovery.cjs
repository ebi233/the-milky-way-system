'use strict';
// A bounded reconciliation window, not a claim of complete server history.
function order(messages){
 const ids=new Set(),positions=new Set();
 return messages.map(m=>{
  if(!m||typeof m.msgId!=='string'||!/^\d{1,24}$/.test(m.msgId))throw Error('INVALID_HISTORY_MESSAGE_ID');
  // clientSeq and server msgSeq are different ordering domains; never mix them.
  const time=String(m.msgTime??''),seq=String(m.msgSeq??'');
  if(!/^\d{1,12}$/.test(time)||!/^\d{1,24}$/.test(seq))throw Error('HISTORY_ORDER_UNAVAILABLE');
  const position=BigInt(time)+':'+BigInt(seq);
  if(ids.has(m.msgId)||positions.has(position))throw Error('HISTORY_ORDER_AMBIGUOUS');
  ids.add(m.msgId);positions.add(position);
  return {m,time:BigInt(time),seq:BigInt(seq)};
 }).sort((a,b)=>a.time<b.time?-1:a.time>b.time?1:a.seq<b.seq?-1:a.seq>b.seq?1:0).map(x=>x.m);
}
async function reconcile(adapter,getLatest,account,peers=adapter.peers()){
 const results=[];
 for(const p of peers){
  const result={scope:'latest-64-native-history',anchor:p.checkpoint,complete:false,gap:true,recovered:0};
  try{
   if(!p.checkpoint)throw Error('NO_BASELINE');
   const raw=await getLatest({chatType:p.chatType,peerUid:p.peerUid,guildId:''},64);
   if(![0,'0'].includes(raw?.result)||!Array.isArray(raw.msgList)||raw.msgList.length>64)throw Error('INVALID_HISTORY_RESPONSE');
   if(raw.msgList.some(m=>!m||m.chatType!==p.chatType||m.peerUid!==p.peerUid))throw Error('HISTORY_PEER_MISMATCH');
   const list=order(raw.msgList);
   const index=list.findIndex(m=>m.msgId===p.checkpoint);if(index<0)throw Error('ANCHOR_OUTSIDE_WINDOW');
   const before=adapter.health().eventSequence;
   for(const m of list.slice(index+1))adapter.receive(m.senderUin===account?'onMsgInfoListUpdate':'onRecvMsg',m,{source:'history',advanceCheckpoint:false});
   result.recovered=adapter.health().eventSequence-before;result.windowCount=list.length;
   // Live events may have advanced the checkpoint while the native query was pending.
   adapter.finishRecovery(p,list.at(-1)?.msgId);
   result.complete=true;result.gap=false;
  }catch(e){result.error=String(e.message).slice(0,120);}
  adapter.recovery(p,result);results.push({uin:p.uin,...result});
 }
 return results;
}
module.exports={reconcile,order};
