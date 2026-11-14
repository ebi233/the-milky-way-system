import {createHash} from 'node:crypto';
export const SILENT_MARKER='[PAOPAO_SILENT]';
const text=m=>(m?.content||[]).filter(c=>c.type==='text').map(c=>c.text||'').join('');
const hash=m=>createHash('sha256').update(text(m)).digest('hex');
const key=s=>String(s??'').trim().replace(/^session-/,'');
const ownerRow=(c,row)=>row?.类型==='私聊' && /^\d+$/.test(String(c.主人号码||'')) && String(row.号码)===String(c.主人号码) && key(row.会话)!=='' && key(row.会话)===key(c.私聊会话);

// A one-use receipt from the scheduler, never inferred from model-written text.
export function createPrivateProactive({now=Date.now}={}){
  const pending=new Map(),turns=new Map();
  function prune(){for(const [id,p] of pending)if(now()-p.at>300000)pending.delete(id);}
  return {
    register(sid,message){
      prune();if(!message?.id||!['speak-up','bili-duty-scan'].includes(message.source?.kind))throw new Error('Invalid proactive receipt');
      pending.set(message.id,{sid:key(sid),at:now(),kind:message.source.kind,hash:hash(message)});
      while(pending.size>64)pending.delete(pending.keys().next().value);
      return ()=>pending.delete(message.id);
    },
    start(sid,turn){turns.set(key(sid),{turn,authorized:false,otherInput:false});},
    input(config,row,message){
      prune();const sid=key(row.会话),t=turns.get(sid),p=pending.get(message?.id);
      if(!t)return;
      const trusted=ownerRow(config,row)&&p?.sid===sid&&message?.source?.kind===p.kind&&p.hash===hash(message);
      if(trusted){pending.delete(message.id);t.authorized=true;}
      else if(['qq','user',''].includes(message?.source?.kind||''))t.otherInput=true;
    },
    finish(config,row,turn){
      const t=turns.get(key(row.会话));turns.delete(key(row.会话));
      return ownerRow(config,row)&&t?.turn===turn&&t.authorized&&!t.otherInput;
    },
    clear(){pending.clear();turns.clear();},
  };
}
export const privateProactive=createPrivateProactive();
export const choosesSilence=text=>String(text||'').includes(SILENT_MARKER);
