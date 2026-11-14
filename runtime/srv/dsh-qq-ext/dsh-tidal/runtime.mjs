import {readAppraisalReference,appraisalStatus,appraisalEnabled} from './appraisal.mjs';
import {associate,associationPolicy} from './association.mjs';
import {expressionSupport,expressionPolicy} from './expression.mjs';
import {renderExpressions} from '../dsh-long-memory/lib/expression-library.mjs';
import {humanRecordText} from '../dsh-long-memory/lib/visible-records.mjs';
import {decide,decisionPolicy} from './decision.mjs';
import {readBounded} from './store.mjs';
import {join} from 'node:path';
import {memoryPolicy} from './memory.mjs';
import {eventPolicy} from './events.mjs';
import {identity,home} from '../dsh-long-memory/lib/access.js';
import {projectAttention} from '../dsh-persona-integrity/attention-runtime.mjs';
import {isMaintenanceMessage} from '../dsh-persona-integrity/maintenance-memory.mjs';
import {projectState,choices,compilePacket,policy} from './core.mjs';
import {controlStore,readMood,enabled,hash} from './store.mjs';
import {systemName,kernelVersion} from './state-kernel.mjs';
import {transitionStatus} from './transition.mjs';
export const tidalEnabled=()=>enabled(home);
const visible=m=>(m?.content||[]).filter(b=>b.type==='text').map(b=>b.text||'').join('\n');
let last=null;
export const tidalStatus=()=>({name:systemName,policy,module:'state-core',eventPolicy,eventRecordLimit:32,modules:{state:kernelVersion,events:eventPolicy,memory:memoryPolicy,association:associationPolicy,decision:decisionPolicy,expression:expressionPolicy,selfTuning:'xinghe-self-review-v1'},kernelVersion,enabled:tidalEnabled(),last,lastUpdate:transitionStatus(),modelCallsAdded:0,appraisal:{enabled:appraisalEnabled(home),...appraisalStatus()},canonicalState:'feiyu-mood/state.json',selfParameters:'tidal-state/policy.json'});
export function projectTidal(messages,agent,{now=Date.now(),who=identity(agent),readControl=()=>controlStore(home).read(),readState=()=>readMood(home,who,{strict:true}),attention=projectAttention}={}){
 const fallback=()=>attention(messages,agent,{now,who});
 let control;try{control=readControl()}catch{last={at:now,status:'unavailable',reason:'policy_unavailable',modelCallsAdded:0};return fallback()}
 if(!control.enabled||who.role!=='owner'||who.inherited||who.conflict)return fallback();
 const clean=messages.filter(m=>!['paopao-tidal-reference','paopao-attention-reference'].includes(m.source?.kind));
 // Never put a user-role reference inside an active tool call/result exchange.
 if(['assistant','tool'].includes(clean.at(-1)?.role))return fallback();
 let index=clean.length-1;while(index>=0&&clean[index].role!=='user')index--;
 const current=clean[index];
 if(!current||!['qq','user'].includes(current.source?.kind)||isMaintenanceMessage(current))return fallback();
 const selected=attention(clean,agent,{now,who});
 let memories=[];
 for(const ref of selected.messages.filter(m=>m.source?.kind==='paopao-attention-reference')){
  const text=visible(ref),start=text.indexOf('\n');
  try{const parsed=JSON.parse(text.slice(start+1));if(Array.isArray(parsed))memories=parsed}catch{}
 }
 let raw;try{raw=readState()}catch{
  last={at:now,status:'unavailable',reason:'state_unavailable',characters:0,modelCallsAdded:0};
  return {...selected,receipt:{...selected.receipt,tidal:last}};
 }
 const state=projectState({raw,scope:who,now,params:control.params});
 const appraisal=readAppraisalReference(home,who,{messageId:current.id,query:humanRecordText(current),now,params:control.params});
 const query=humanRecordText(current),associations=associate(query,memories,{now,params:control.params,recentMessages:clean,queryContext:selected.receipt?.queryContext});
 const expression=expressionSupport(clean,query,{scope:who.session,params:control.params,example:renderExpressions(agent,{projection:true,recentMessages:clean})});
 // A neutral daytime carries no new information. Keep the original attention reference in that case.
 if(!Object.keys(state.affect).length&&!Object.keys(state.activity).length&&state.body.phase==='day'&&!memories.length&&!Object.keys(expression.data).length&&!associations.length&&!Object.keys(appraisal).length){
  last={at:now,status:'neutral',diagnostics:state.diagnostics,parameterRevision:control.revision,characters:0,modelCallsAdded:0};return {...selected,receipt:{...selected.receipt,tidal:last}};
 }
 const packet=compilePacket({state,memories,params:control.params,candidates:[],associations,expression:expression.data,appraisal,now});
 const ref={id:'tidal-'+hash(packet.text).slice(0,24),role:'user',source:{kind:'paopao-tidal-reference'},content:[{type:'text',text:packet.text}]};
 last={at:now,status:'projected',...packet.stats,diagnostics:state.diagnostics,parameterRevision:control.revision};
 return {messages:[...clean.slice(0,index),ref,...clean.slice(index)],receipt:{...selected.receipt,tidal:last}};
}
export function activityState(agent,scope,{now=Date.now(),checks=0,incoming=false,proactiveAllowed=true,hasTopic=false,hasDiscovery=false}={}){
 if(!tidalEnabled())return null;
 const who=identity(agent);if(who.inherited||who.conflict||who.role!==(scope==='private'?'owner':'group'))return null;
 try{
  const c=controlStore(home).read(),raw=readMood(home,who,{strict:true}),state=projectState({raw,scope:who,now,params:who.role==='owner'?c.params:undefined});
  const options=choices(state,{incoming,proactiveAllowed,hasTopic,hasDiscovery});
  // Stable diversity across opportunities; evaluating the same opportunity does not reroll it.
  let history=[];if(scope==='private'){try{const receipt=readBounded(join(home,'speak-up-delivery.json'),65536);if(receipt.version===1&&Array.isArray(receipt.history))history=receipt.history.slice(-40)}catch{}}
  const decision=decide(options,{checks,history,now,params:c.params,incoming,allowed:proactiveAllowed}),chosen=options.find(x=>x.kind===decision.chosen)||options[0];
  const ranked=[chosen,...options.filter(x=>x!==chosen)];
  const packet=compilePacket({state,candidates:ranked,appraisal:readAppraisalReference(home,who,{now,params:c.params})});
  return {decision,quiet:decision.chosen==='quiet',preferred:['continue_topic','public_discovery','casual'].includes(chosen.kind)?chosen.kind:null,text:packet.text,weights:decision.weights,stats:packet.stats};
 }catch{return null}
}
