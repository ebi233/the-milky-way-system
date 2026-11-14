import {createHash} from 'node:crypto';
const key=v=>String(v||'').replace(/^session-/,'');
const digest=m=>createHash('sha256').update(JSON.stringify([m?.source?.kind,m?.content])).digest('hex');
// Internal one-use metadata; neither model text nor user messages can create a receipt.
export function createPurposeReceipts({now=Date.now}={}){
  const pending=new Map(),turns=new Map();
  const prune=()=>{for(const [k,v] of pending)if(now()-v.at>300000)pending.delete(k);};
  return {
    register(sid,message,token){
      if(!token)return ()=>{};
      if(!message?.id||!['speak-up','group-proactive'].includes(message.source?.kind)||key(token.session)!==key(sid))throw Error('Invalid purpose receipt');
      prune();pending.set(message.id,{sid:key(sid),hash:digest(message),token,at:now()});
      while(pending.size>64)pending.delete(pending.keys().next().value);
      return ()=>pending.delete(message.id);
    },
    start(sid,turn){turns.set(key(sid),{turn,token:null,mixed:false});},
    input(sid,message){
      prune();const t=turns.get(key(sid)),p=pending.get(message?.id);if(!t)return;
      if(p?.sid===key(sid)&&p.hash===digest(message)){pending.delete(message.id);if(t.token)t.mixed=true;t.token=p.token;}
      else if(['qq','user',''].includes(message?.source?.kind||''))t.mixed=true;
    },
    finish(sid,turn){const t=turns.get(key(sid));turns.delete(key(sid));return t?.turn===turn&&t.token?{token:t.token,cancelled:t.mixed}:null;},
    clear(){pending.clear();turns.clear();},
  };
}
export const purposeReceipts=createPurposeReceipts();
