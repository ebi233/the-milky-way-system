import {eventStore} from './event-store.mjs';
import {controlStore,readMood,readBounded} from './store.mjs';
import {join} from 'node:path';
import {parameters} from './state-kernel.mjs';
import {projectState,choices} from './core.mjs';
import {decide} from './decision.mjs';
export const reviewPolicy='xinghe-self-review-v1';
export function review(home,who,now=Date.now()){
 const c=controlStore(home).read(),state=projectState({raw:readMood(home,who,{strict:true}),scope:who,now,params:c.params});
 const records=eventStore(home,who.session).read().records;
 const byRevision={},rejectionReasons={};let missingSourceTime=0,legacyReasonRecords=0;
 for(const r of records){
  if(!Number.isFinite(r.source?.at))missingSourceTime++;
  if(!Array.isArray(r.rejectionDetails)&&r.rejected?.length)legacyReasonRecords++;
  for(const d of r.rejectionDetails||[])rejectionReasons[d.reason]=(rejectionReasons[d.reason]||0)+1;
  const key=r.parameterRevision??'unknown';byRevision[key]??={records:0,saved:0,noChange:0,unresolved:0,writeFailures:0};
  const v=byRevision[key];v.records++;if(r.stateResult==='saved')v.saved++;if(r.stateResult==='no_change')v.noChange++;if(r.assessmentStatus==='unresolved')v.unresolved++;if(r.stateResult==='not_saved')v.writeFailures++;
 }
 let activity={available:false};try{const s=readBounded(join(home,'speak-up-delivery.json'),65536);if(s.version===1)activity={available:true,checks:s.checks,sent:s.sent,quietDecisions:s.quietDecisions||0,lastOutcome:s.lastOutcome||null,lastDecision:s.lastDecision||null}}catch{}
 return {policy:reviewPolicy,scope:who.session,revision:c.revision,enabled:c.enabled,diagnostics:state.diagnostics,eventWindow:records.length,byRevision,rejectionReasons,missingSourceTime,legacyReasonRecords,activity,quality:'operational_observation_not_a_naturalness_score',modelCallsAdded:0,personaChanged:false};
}
export function preview(home,who,changes,now=Date.now()){
 const c=controlStore(home).read();if(!c.enabled)throw Error('星河系统已停用');
 if(!changes||typeof changes!=='object'||Array.isArray(changes))throw Error('需要参数 changes');
 const proposed=parameters({...c.params,...changes}),raw=readMood(home,who,{strict:true});
 const run=params=>{
  const state=projectState({raw,scope:who,now,params});
  return {state,illustrativeChoice:decide(choices(state,{hasTopic:true,hasDiscovery:true}),{now,checks:1,params})};
 };
 return {policy:reviewPolicy,revision:c.revision,params:proposed,before:run(c.params),after:run(proposed),hypothetical:true,writes:0,modelCallsAdded:0,note:'只试算，不代表真实聊天效果；采用需另行 edit 并带当前 expected_revision，之后可按版本 rollback。'};
}
