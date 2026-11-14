import {selectMemory} from '../dsh-tidal/memory.mjs';
import {resolveRecallContext} from '../dsh-tidal/recall-context.mjs';
import {controlStore} from '../dsh-tidal/store.mjs';
import fs from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {selectAttention,attentionPolicy,attentionLimits} from './attention-selection.mjs';
import {identity,home} from '../dsh-long-memory/lib/access.js';
import {humanRecordText} from '../dsh-long-memory/lib/visible-records.mjs';
import {isMaintenanceMessage} from './maintenance-memory.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');
export function readAttentionStore(scope){
 const file=join(home,'conversation-notes',sha(`owner:${scope.qq}:${scope.session}`)+'.json');
 let fd;
 try{
  fd=fs.openSync(file,'r');const stat=fs.fstatSync(fd);
  if(!stat.isFile()||stat.size>attentionLimits.maxStoreBytes)throw Error('store_bound');
  const buffer=Buffer.alloc(stat.size+1);let n=0,got;
  while(n<buffer.length&&(got=fs.readSync(fd,buffer,n,buffer.length-n,null)))n+=got;
  if(n!==stat.size)throw Error('store_changed');
  return JSON.parse(buffer.subarray(0,n).toString('utf8'));
 }finally{if(fd!==undefined)fs.closeSync(fd);}
}
// Only an ephemeral request is projected. Never save this message to a session.
export function projectAttention(messages,agent,{now=Date.now(),read=readAttentionStore,who=identity(agent)}={}){
 const receipt={policy:attentionPolicy,at:now,status:'skipped',reason:'scope',chars:0,selected:[]};
 if(who.role!=='owner'||who.inherited||who.conflict)return {messages,receipt};
 const clean=messages.filter(m=>m.source?.kind!=='paopao-attention-reference');
 let i=clean.length-1;while(i>=0&&clean[i].role!=='user')i--;
 const latest=clean[i];
 if(!latest||!['qq','user'].includes(latest.source?.kind)||isMaintenanceMessage(latest))return {messages:clean,receipt:{...receipt,reason:'no_current_human'}};
 try{
  let control;try{control=controlStore(home).read()}catch{}
  const selector=control?.enabled?selectMemory:selectAttention;
  const query=humanRecordText(latest);
  const recallContext=control?.enabled?resolveRecallContext(query,clean.slice(0,i+1),agent,{now}):null;
  const result=selector({data:read(who),scope:who,query,now,params:control?.params,recallContext,recentMessages:clean.slice(0,i+1)});
  Object.assign(receipt,result.receipt,{status:'ok',reason:null});
  if(!result.text)return {messages:clean,receipt};
  const ref={id:'attention-'+sha(result.text).slice(0,24),role:'user',source:{kind:'paopao-attention-reference'},content:[{type:'text',text:result.text}]};
  return {messages:[...clean.slice(0,i),ref,...clean.slice(i)],receipt};
 }catch(e){return {messages:clean,receipt:{...receipt,status:e.code==='ENOENT'?'empty':'error',reason:e.code==='ENOENT'?'no_store':'unavailable_or_invalid'}};}
}
