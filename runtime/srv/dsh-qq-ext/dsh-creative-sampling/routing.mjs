import {readFileSync} from 'node:fs';
export const DEFAULT_ROUTING=Object.freeze({enabled:true,chatModel:'deepseek-v4-pro',backgroundModel:'deepseek-flash'});
const models=new Set(['deepseek-v4-pro','deepseek-flash','deepseek-v4-flash']);
export function loadRouting(path){
  let c;try{c=JSON.parse(readFileSync(path,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e;return DEFAULT_ROUTING}
  if(typeof c.enabled!=='boolean'||!models.has(c.chatModel)||!models.has(c.backgroundModel))throw Error('Invalid model routing');
  const effort=c.chatReasoningEffort;
  if(effort!==undefined&&!['off','low','high','max'].includes(effort))throw Error('Invalid chat reasoning effort');
  const trial=c.chatReasoningTrial;
  if(trial!==undefined&&(!trial||trial.effort!=='max'||trial.restoreEffort!=='high'||typeof trial.id!=='string'||!Number.isSafeInteger(trial.startsAt)||!Number.isSafeInteger(trial.expiresAt)||trial.expiresAt<=trial.startsAt))throw Error('Invalid reasoning trial');
  return {enabled:c.enabled,chatModel:c.chatModel,backgroundModel:c.backgroundModel,...(effort!==undefined?{chatReasoningEffort:effort}:{}),...(trial?{chatReasoningTrial:trial}:{})};
}
export function routeRequest(previous,who,policy=DEFAULT_ROUTING){
  if(!policy.enabled||previous.provider!=='deepseek-official'||!models.has(previous.model))return {request:previous,route:'unchanged'};
  const backgroundPurpose=['session-title','compaction','summarization'].includes(previous.purpose);
  const chat=!backgroundPurpose && !who?.inherited && ['owner','guest','group'].includes(who?.role);
  const model=chat?policy.chatModel:policy.backgroundModel;
  return {request:previous.model===model?previous:{...previous,model},route:chat?'chat':'background'};
}

export function reasoningTrialState(policy,now=Date.now()){
 if(policy.chatReasoningEffort!==undefined)return {enabled:true,phase:'configured',effort:policy.chatReasoningEffort,source:'explicit_chat_configuration',expiresAt:null};
 const t=policy.chatReasoningTrial;
 if(!t)return {enabled:false};
 const active=now>=t.startsAt&&now<t.expiresAt;
 return {enabled:true,id:t.id,phase:now<t.startsAt?'scheduled':active?'active':'restored',effort:active?t.effort:t.restoreEffort,expiresAt:t.expiresAt};
}
export function applyReasoningTrial(previous,who,policy,now=Date.now()){
 const t=reasoningTrialState(policy,now);
 if(!t.enabled||!policy.enabled||previous.provider!=='deepseek-official'||previous.model!==policy.chatModel||who?.inherited||!['owner','guest','group'].includes(who?.role)||['session-title','compaction','summarization'].includes(previous.purpose))return previous;
 return {...previous,reasoningEffort:t.effort};
}
