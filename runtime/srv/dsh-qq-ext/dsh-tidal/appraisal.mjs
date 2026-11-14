import {currentStyleDiscussion} from '../dsh-long-memory/lib/expression-quality.mjs';
import fs from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {identity} from '../dsh-long-memory/lib/access.js';
import {humanRecordText,projectVisibleEvents} from '../dsh-long-memory/lib/visible-records.mjs';
import {isMaintenanceMessage} from '../dsh-persona-integrity/maintenance-memory.mjs';
import {readBounded,enabled,readMood,controlStore} from './store.mjs';
import {projectState} from './core.mjs';
import {appraisalPolicy,relationshipPolicy,relationshipReferencePolicy,appraisalSystem,digest,emptyDossier,validDossier,validateAppraisal,applyRelationship,appraisalReference} from './appraisal-core.mjs';
export {appraisalPolicy,relationshipPolicy};
const active=new Map();let last={policy:appraisalPolicy,status:'waiting'};
const gateCounts={};let lastGate=null;
function gate(reason,now){gateCounts[reason]=Math.min(1000000,(gateCounts[reason]||0)+1);lastGate={reason,at:now};}
export const appraisalStatus=()=>({...last,relationshipPolicy,referencePolicy:relationshipReferencePolicy,inputGate:{last:lastGate?{...lastGate}:null,counts:{...gateCounts}},inFlight:active.size,assessmentPlacement:'before_reply',callsPerEligibleTurn:1,maxWaitMs:8000});
export function appraisalEnabled(home){try{const c=readBounded(join(home,'tidal-state/appraisal-policy.json'),4096);return enabled(home)&&c.version===1&&c.enabled===true&&c.timeoutMs===8000;}catch{return false}}
const scoped=who=>who?.role==='owner'&&!who.inherited&&!who.conflict&&typeof who.qq==='string'&&typeof who.session==='string';
const scopeOf=who=>'owner:'+who.qq+':'+who.session;
function dossierPath(home,scope){return join(home,'tidal-state','appraisal-'+digest(scope)+'.json');}
export function readDossier(home,who){
 if(!scoped(who))throw Error('Appraisal owner scope required');
 const scope=scopeOf(who);try{return validDossier(readBounded(dossierPath(home,scope),65536),scope)}catch(e){if(e.code==='ENOENT')return emptyDossier(scope);throw e}
}
function changeDossier(home,who,fn){
 const scope=scopeOf(who),file=dossierPath(home,scope),lock=file+'.lock';let fd;
 try{fd=fs.openSync(lock,'wx',0o600)}catch{throw Error('Appraisal store busy')}
 let tmp;
 try{
  const d=readDossier(home,who);const result=fn(d);if(result===false)return d;
  d.revision++;validDossier(d,scope);const blob=JSON.stringify(d);
  if(Buffer.byteLength(blob)>65536)throw Error('Appraisal store bound');
  tmp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,blob,{mode:0o600});fs.renameSync(tmp,file);tmp=null;return d;
 }finally{if(tmp&&fs.existsSync(tmp))fs.unlinkSync(tmp);fs.closeSync(fd);fs.unlinkSync(lock)}
}
const stamp=e=>typeof e.time==='string'?Date.parse(e.time):Number(e.time??e.timestamp??e.at);
export function inspectAppraisalInput(agent,options,who,{now=Date.now()}={}){
 const deny=reason=>({reason,input:null});
 if(!scoped(who))return deny('not_owner');
 if(!Array.isArray(options.messages))return deny('missing_messages');
 if(['assistant','tool'].includes(options.messages.at(-1)?.role))return deny('continuation_request');
 const events=agent.session.snapshotEvents().slice(-256),start=events.findLastIndex(e=>e.type==='turn/start');
 if(start<0)return deny('missing_turn_start');
 const turn=events.slice(start);
 if(turn.some(e=>e.type==='turn/end'))return deny('completed_turn');
 if(turn.some(e=>e.type==='tool/call'))return deny('tool_continuation');
 if(turn.some(e=>e.type==='assistant/message'))return deny('reply_started');
 const humans=turn.filter(e=>e.type==='user/message'&&['qq','user'].includes((e.data?.message||e.data)?.source?.kind));
 if(humans.length!==1)return deny(humans.length?'multiple_humans':'no_human');
 const e=humans[0],m=e.data?.message||e.data,at=stamp(e),text=humanRecordText(m);
 if(typeof m?.id!=='string'||!m.id||m.id.length>160)return deny('missing_message_id');
 if(!text||text.length>1600)return deny('text_bound');
 if(!Number.isFinite(at)||at<=0)return deny('missing_time');
 if(at>now)return deny('future_input');
 if(now-at>10*60000)return deny('stale_input');
 if(isMaintenanceMessage(m))return deny('maintenance');
 if(!Array.isArray(m.content)||m.content.some(b=>b.type!=='text')||/合并转发|引用了一条消息|系统图片观察|系统语音|系统文件|老哥发了.{0,8}张图/u.test(m.content.map(b=>b.text||'').join('\n')))return deny('unsupported_content');
 const latest=options.messages.findLast(x=>x.role==='user'&&['qq','user'].includes(x.source?.kind));
 if(latest?.id!==m.id||humanRecordText(latest)!==text)return deny('request_source_mismatch');
 // No tools, summaries, forwards or hidden reasoning enter the small context window.
 let recent=[];try{recent=projectVisibleEvents([{type:'session',version:4,id:who.session},...events.slice(0,start)],who.session,{allowUserAfter:0,skipFirstUserTurn:true,plainDialogueOnly:true}).filter(r=>r.at<=at&&at-r.at<=30*60000&&r.messageId!==m.id).slice(-4).map(r=>({role:r.role,text:r.text.slice(0,280),at:r.at}));}catch{}
 return {reason:'eligible',input:{scope:scopeOf(who),messageId:m.id,text,at,recent,inputHash:digest(text)}};
}
export function currentAppraisalInput(agent,options,who,config){return inspectAppraisalInput(agent,options,who,config).input;}
export function replacesPostAssessment(home,who,info){
 if(!appraisalEnabled(home)||!scoped(who)||!info?.provenance?.messageId)return false;
 // The persisted claim counts even on timeout/restart: never pay twice for this input.
 try{return readDossier(home,who).receipts.some(r=>r.messageId===info.provenance.messageId)}catch{return true}
}
export function readAppraisalReference(home,who,{messageId,query='',now=Date.now(),params={}}={}){
 if(!appraisalEnabled(home)||!scoped(who)||currentStyleDiscussion(query))return {};
 try{return appraisalReference(readDossier(home,who),{messageId,query,now,emotionHalfMinutes:params.emotionHalfMinutes??90})}catch{return {}}
}
export async function prepareAppraisal(ctx,agent,options,{home,now=Date.now()}={}){
 const who=identity(agent);
 if(!appraisalEnabled(home)||!scoped(who)){gate('disabled_or_scope',now);return {status:'disabled'};}
 let input;try{readMood(home,who,{strict:true});const inspected=inspectAppraisalInput(agent,options,who,{now});gate(inspected.reason,now);input=inspected.input;}catch{gate('source_unavailable',now);return {status:'unavailable'}}
 if(!input)return {status:'ineligible',reason:lastGate.reason};
 const key=input.scope+'\0'+input.messageId;
 if(active.has(key)){gate('in_flight_reuse',now);return active.get(key);}
 const execute=async()=>{
  let before;try{
   before=readDossier(home,who);
   const prior=before.receipts.find(r=>r.messageId===input.messageId);
   if(prior){gate('already_assessed',now);return {status:prior.status==='ready'?'cached':prior.status};}
   changeDossier(home,who,d=>{if(d.receipts.some(r=>r.messageId===input.messageId))return false;d.receipts.push({messageId:input.messageId,inputHash:input.inputHash,at:input.at,status:'pending'});d.receipts=d.receipts.slice(-32);});
  }catch{gate('store_unavailable',now);return {status:'unavailable'}}
  last={policy:appraisalPolicy,status:'running',at:now};
  input.relationships=before.relationships;
  let priorState={},priorAppraisal=null;try{
   const params=controlStore(home).read().params,s=projectState({raw:readMood(home,who,{strict:true}),scope:who,now,params});priorState={affect:s.affect,activity:s.activity};
   const prev=before.receipts.findLast(r=>r.status==='ready'&&r.at<=now&&now-r.at<24*3600000&&r.result?.reactions?.length);
   if(prev){const reactions=prev.result.reactions.map(r=>({...r,value:Math.round(r.value*2**(-(now-prev.at)/(params.emotionHalfMinutes*60000)))})).filter(r=>r.value>=10);if(reactions.length)priorAppraisal={event:prev.result.event,reactions,at:prev.at,basis:'previous_inference_not_new_evidence'};}
  }catch{}
  let result=null,failure='invalid',count=0,timer,modelStartedAt=null;
  const controller=new AbortController();
  const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
  try{
   options.signal?.throwIfAborted();
   const consume=async()=>{
    let output='',finished=false;
    modelStartedAt=Date.now();
    for await(const chunk of ctx.llm.stream({provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'off',purpose:'xinghe-event-appraisal',system:appraisalSystem,
      messages:[{role:'user',id:randomUUID(),source:{kind:'plugin',plugin:'xinghe-appraisal'},content:[{type:'text',text:JSON.stringify({current:{text:input.text,at:input.at},recent:input.recent,relationships:input.relationships,priorState,priorAppraisal})}]}],tools:[],maxTokens:1200,temperature:.2,signal})){
     if(chunk?.type==='text-delta'){output+=chunk.text;count=output.length;if(count>10000)throw Error('output_bound');}
     if(chunk?.type==='finish'&&chunk.reason?.kind==='stop')finished=true;
     if(chunk?.type==='finish'&&chunk.reason?.kind==='error')throw Error('provider_error');
    }
    if(!finished)throw Error('incomplete');return validateAppraisal(output,input);
   };
   result=await Promise.race([consume(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('timeout'));},8000);})]);
   if(!result)failure='invalid';
   if(result&&currentStyleDiscussion(input.text))result.reactions=[];
   // Repeating the same event excerpt is not fresh affect evidence.
   if(result&&before.receipts.some(r=>r.status==='ready'&&r.at<=input.at&&input.at-r.at<24*3600000&&r.result?.event?.kind===result.event.kind&&r.result?.event?.quote===result.event.quote))result.reactions=[];
  }catch(e){failure=options.signal?.aborted?'cancelled':controller.signal.aborted?'timeout':['output_bound','incomplete','provider_error'].includes(e.message)?e.message:'provider_error';}
  finally{clearTimeout(timer);controller.abort();}
  const modelDurationMs=modelStartedAt===null?0:Date.now()-modelStartedAt;
  // Never install results from a cancelled request or a changed owner binding.
  if(options.signal?.aborted||JSON.stringify(identity(agent))!==JSON.stringify(who)||!appraisalEnabled(home)){result=null;failure='cancelled';}
  let relationshipResult={changed:false};
  try{changeDossier(home,who,d=>{
   const r=d.receipts.find(r=>r.messageId===input.messageId&&r.inputHash===input.inputHash);if(!r||r.status!=='pending')return false;
   r.status=result?'ready':'failed';r.completedAt=Date.now();r.modelDurationMs=modelDurationMs;r.outputCharacters=count;r.modelCalls=modelStartedAt===null?0:1;
   if(result){r.result={event:result.event,reactions:result.reactions};relationshipResult=applyRelationship(d,input,result.relationship,Date.now());r.relationshipResult=relationshipResult;}
   else r.failure=failure;
  });}catch{result=null;failure='storage_unavailable';}
  last={policy:appraisalPolicy,status:result?'ready':'failed',reason:result?undefined:failure,at:Date.now(),durationMs:Date.now()-now,modelDurationMs,outputCharacters:count,reactionCount:result?.reactions.length||0,relationshipChanged:relationshipResult.changed,modelCalls:modelStartedAt===null?0:1};
  options.signal?.throwIfAborted();return last;
 };
 const pending=execute();active.set(key,pending);try{return await pending}finally{active.delete(key)}
}
