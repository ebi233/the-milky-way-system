import fs from 'node:fs';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {visibleMetrics,observeVisible,traceSnapshot} from './audit-core.mjs';
import {inputReceiptPolicy} from './input-receipt.mjs';
import {captureRepetitionInput,inspectRepetition,redactRepetition,repetitionPolicy} from './repetition-audit.mjs';
export function installAudit(ctx,home,identify,personaVersions){
 const folder=join(home,'runtime-health'),file=join(folder,'conversation-audit.jsonl');let persistenceError=false;
 function append(record){
  try{
   fs.mkdirSync(folder,{recursive:true,mode:0o700});
   if(fs.existsSync(file)&&fs.statSync(file).size>2*1024*1024){const old=file+'.previous';if(fs.existsSync(old))fs.unlinkSync(old);fs.renameSync(file,old)}
   fs.appendFileSync(file,JSON.stringify(record)+'\n',{mode:0o600});persistenceError=false;
  }catch{persistenceError=true;}
 }
 function observe(options,next){
  let trace,repetitionInput;
  try{
   if(['agent','paopao-context-projected','paopao-empty-recovery'].includes(options.purpose||'agent')&&options.sessionId){
   const agent=ctx.agents.get(options.sessionId),who=agent&&identify(agent);
   if(who&&['owner','guest','group'].includes(who.role)&&!who.inherited&&!who.conflict){
   const persona=who.role==='owner'?personaVersions(home).current():{text:'public_profile',revision:'public_profile',mode:'public'};
   trace={id:randomUUID(),startedAt:Date.now(),role:who.role,...traceSnapshot(options,agent,persona)};
   if(who.role!=='owner')trace.personaSystemMatches=null;
   if(who.role==='owner')repetitionInput=captureRepetitionInput(options.messages||[]);
   append({...trace,phase:'started'});
   }}
  }catch{persistenceError=true;}
  const finish=result=>{
   const metrics=visibleMetrics(result.text);
   if(repetitionInput&&result.finish==='stop'&&result.text.trim()){
    try{metrics.repetition=redactRepetition(inspectRepetition([...repetitionInput,{id:'generated:'+trace.id,role:'assistant',source:{kind:'model'},content:[{type:'text',text:result.text}]}],{scope:trace.sessionId}));}
    catch{metrics.repetitionObservationError=true;}
   }
   append({...trace,phase:'finished',endedAt:Date.now(),finish:result.finish,truncated:result.truncated,metrics});
  };
  let stream;try{stream=next()}catch(error){if(trace)finish({finish:'exception',text:'',truncated:false});throw error;}
  return trace?observeVisible(stream,finish):stream;
 }
 function state(){
  let records=[];
  for(const p of [file+'.previous',file])try{for(const line of fs.readFileSync(p,'utf8').split('\n').filter(Boolean)){try{records.push(JSON.parse(line))}catch{}}}catch{}
  records=records.filter(r=>(r.endedAt||r.startedAt)>Date.now()-86400000);
  const byId=new Map();for(const r of records)byId.set(r.id,r);
  const all=[...byId.values()],rows=all.filter(r=>r.phase!=='started'),completed=rows.filter(r=>r.finish==='stop');
  const owners=all.filter(r=>r.role==='owner').sort((a,b)=>a.startedAt-b.startedAt),latest=owners.at(-1)||null;
  const prior=latest?owners.filter(r=>r.sessionId===latest.sessionId&&r.id!==latest.id&&r.inputReceipt?.policy===inputReceiptPolicy).at(-1):null;
  const repetitionRecord=owners.findLast(r=>r.sessionId===latest?.sessionId&&r.personaHash===latest?.personaHash&&r.model===latest?.model&&r.provider===latest?.provider&&r.reasoningEffort===latest?.reasoningEffort&&r.metrics?.repetition?.policy===repetitionPolicy);
  const repetitionObservation=repetitionRecord?{available:true,observedAt:repetitionRecord.endedAt,traceId:repetitionRecord.id,...repetitionRecord.metrics.repetition}:{available:false,policy:repetitionPolicy,reason:'awaiting_completed_owner_reply'};
  const changes=latest?.inputReceipt&&prior?{persona:latest.personaHash!==prior.personaHash,
   model:latest.model!==prior.model||latest.provider!==prior.provider||latest.reasoningEffort!==prior.reasoningEffort,
   system:latest.inputSystemHash!==prior.inputSystemHash,checkpoint:JSON.stringify(latest.inputReceipt.checkpoints.map(x=>x.sha256))!==JSON.stringify(prior.inputReceipt.checkpoints.map(x=>x.sha256))}:null;
  return {version:2,policy:inputReceiptPolicy,modelCallsAdded:0,storesText:false,persistenceError,calls24h:all.length,latest:rows.at(-1)||null,
   ownerLatest:latest,ownerChanges:changes,repetitionObservation,pendingCount:all.filter(r=>r.phase==='started').length,
   longUnbroken24h:completed.filter(r=>r.metrics?.longUnbroken).length,controlMarkerSuspected24h:completed.filter(r=>r.metrics?.controlMarkerSuspected).length,assistantVoiceSuspected24h:completed.filter(r=>r.metrics?.assistantVoiceSuspected).length,
   note:'记录上下文整理后、供应商适配前的输入指纹和来源编号；不存正文、内部推理或工具参数。started仅表示开始，未完成不等于主动沉默；生成完成也不等于QQ送达'};
 }
 state.observe=observe;return state;
}
