import {createHash} from 'node:crypto';
const key=s=>String(s||'').replace(/^session-/,'');
const digest=m=>createHash('sha256').update(JSON.stringify(m)).digest('hex');
const owner=(c,r)=>r?.类型==='私聊'&&String(r.号码)===String(c.主人号码)&&/^\d+$/.test(String(c.主人号码))&&key(r.会话)===key(c.私聊会话);
// Only host-registered, exact messages authorize this one private delivery.
export function createImageDeliveryReceipts(){
 const pending=new Map(),turns=new Map();
 return {
  register(sid,message,settle){
   if(message.source?.kind!=='image-handoff-ready')throw Error('Invalid image source');
   pending.set(message.id,{sid:key(sid),hash:digest(message),settle});
   return ()=>pending.delete(message.id);
  },
  start(sid,turn){turns.set(key(sid),{turn,receipts:[],mixed:false});},
  input(config,row,message){
   const t=turns.get(key(row.会话)),p=pending.get(message?.id);if(!t)return;
   if(owner(config,row)&&p?.sid===key(row.会话)&&p.hash===digest(message)){
    pending.delete(message.id);t.receipts.push(p);p.settle({phase:'notified'});
   }else if(!['model-selection','agent-instructions','compact-checkpoint','skill-catalog'].includes(message.source?.kind))t.mixed=true;
  },
  finish(config,row,turn){
   const t=turns.get(key(row.会话));turns.delete(key(row.会话));
   if(!t?.receipts.length)return null;
   if(!owner(config,row)||t.turn!==turn||t.mixed){for(const p of t.receipts)p.settle({phase:'needs_check',reason:'mixed_or_changed_session'});return null;}
   let done=false;
   return {settle(result){if(done)return;done=true;for(const p of t.receipts)p.settle(result);}};
  }
 };
}
export const imageDeliveryReceipts=createImageDeliveryReceipts();
