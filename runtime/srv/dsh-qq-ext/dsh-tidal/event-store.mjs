import fs from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {readBounded,controlStore} from './store.mjs';
import {eventPolicy} from './events.mjs';
export const eventLimits={records:32,bytes:131072,cardBytes:16384};
export function eventStore(home,scope){
 if(typeof scope!=='string'||!/^session-[\w-]{1,120}$/.test(scope))throw Error('Event scope');
 const dir=join(home,'tidal-state','events'),file=join(dir,createHash('sha256').update(scope).digest('hex')+'.json');
 function read(){
  let d;try{d=readBounded(file,eventLimits.bytes)}catch(e){if(e.code==='ENOENT')return {policy:eventPolicy,scope,records:[]};throw e}
  if(d.policy!==eventPolicy||d.scope!==scope||!Array.isArray(d.records)||d.records.length>eventLimits.records||d.records.some(r=>r.scope!==scope||r.policy!==eventPolicy||!/^\w{64}$/.test(r.eventId)))throw Error('Invalid event ledger');
  return d;
 }
 function completed(id){return read().records.some(r=>r.eventId===id&&['saved','no_change'].includes(r.stateResult))}
 function append(card,stateResult,now=Date.now()){
  if(card?.policy!==eventPolicy||card.scope!==scope||!/^[a-f0-9]{64}$/.test(card.eventId)||!['saved','no_change','not_saved'].includes(stateResult)||Buffer.byteLength(JSON.stringify(card))>eventLimits.cardBytes)throw Error('Invalid event card');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const lock=file+'.lock';const fd=fs.openSync(lock,'wx',0o600);let tmp;
  try{
   const d=read(),old=d.records.find(r=>r.eventId===card.eventId);
   if(old&&['saved','no_change'].includes(old.stateResult))return {duplicate:true,records:d.records.length};
   d.records=d.records.filter(r=>r.eventId!==card.eventId);
   let parameterRevision=null;try{parameterRevision=controlStore(home).read().revision}catch{}
   d.records.push({...card,parameterRevision,recordedAt:now,stateResult});d.records=d.records.slice(-eventLimits.records);
   let blob=JSON.stringify(d);
   while(Buffer.byteLength(blob)>eventLimits.bytes&&d.records.length>1){d.records.shift();blob=JSON.stringify(d)}
   if(Buffer.byteLength(blob)>eventLimits.bytes)throw Error('Event ledger bound');
   tmp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,blob,{mode:0o600});fs.renameSync(tmp,file);tmp=null;
   return {records:d.records.length,bytes:Buffer.byteLength(blob)};
  }finally{if(tmp&&fs.existsSync(tmp))fs.unlinkSync(tmp);fs.closeSync(fd);fs.unlinkSync(lock)}
 }
 return {read,completed,append,file};
}
