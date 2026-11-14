import {parameters} from './state-kernel.mjs';
export const decisionPolicy='xinghe-decision-v1';
export function decide(candidates,{checks=0,history=[],now=Date.now(),params={},incoming=false,allowed=true}={}){
 const p=parameters(params);
 if(incoming)return {policy:decisionPolicy,chosen:'respond',reason:'current_human',weights:[{kind:'respond',score:1}],feedback:0};
 if(!allowed)return {policy:decisionPolicy,chosen:'quiet',reason:'delivery_policy',weights:[{kind:'quiet',score:1}],feedback:0};
 const outcomes=[];let queued=null;
 for(const row of history.slice(-40)){
  if(!Number.isFinite(row.at)||row.at>now||now-row.at>86400000)continue;
  if(row.kind==='queued')queued=row;
  else if(queued&&['sent','silent','generation_failed','delivery_failed','empty_output'].includes(row.kind)){outcomes.push({kind:queued.plan,outcome:row.kind,at:row.at});queued=null}
 }
 const recent=outcomes.slice(-4),weights=candidates.filter(x=>['quiet','continue_topic','public_discovery','casual'].includes(x.kind)&&Number.isFinite(x.score)&&x.score>0).map(x=>{
  // Confirmed send does not mean the user enjoyed it. Silence is not rejection.
  const repeat=recent.filter(r=>r.kind===x.kind&&r.outcome==='sent').length;
  const failures=recent.filter(r=>r.kind===x.kind&&['generation_failed','delivery_failed','empty_output'].includes(r.outcome)).length;
  const factor=x.kind==='quiet'?1:1/(1+p.initiativeFeedbackWeight*(repeat*.5+failures));
  return {...x,score:Number(Math.max(.05,x.score*factor).toFixed(4)),confirmedSends:repeat,failures};
 });
 if(!weights.length)weights.push({kind:'quiet',score:1});
 // Stable per opportunity and evolves after a genuine quiet decision; no random re-roll on read.
 let n=((Math.max(0,Math.floor(Number(checks)||0))*.61803398875+.37)%1)*weights.reduce((s,x)=>s+x.score,0),chosen=weights.at(-1).kind;
 for(const x of weights){n-=x.score;if(n<0){chosen=x.kind;break}}
 return {policy:decisionPolicy,chosen,reason:'bounded_state_and_receipts',weights,feedback:recent.length};
}
