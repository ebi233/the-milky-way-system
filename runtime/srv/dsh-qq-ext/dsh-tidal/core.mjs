// Pure simulation and context compilation. No network, arbitrary code, or clocks hidden from tests.
export const policy='xinghe-state-v1';
export const limits=Object.freeze({packetChars:1200,stateChars:260,memoryItems:3,memoryQuoteChars:180});
export {defaults,parameters} from './state-kernel.mjs';
import {defaults,parameters,axes,projectAxes} from './state-kernel.mjs';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
// Time changes a weak simulated activity baseline, never a claim of having slept/eaten.
export function bodyClock(now){
 if(!Number.isFinite(now))throw Error('Invalid time');
 const hour=((now/3600000+8)%24+24)%24;
 return {phase:hour>=1&&hour<8?'night':'day',energy:Math.round(50+12*Math.cos((hour-15)*Math.PI/12)),basis:'simulated_clock_not_observed_experience'};
}
export function projectState({raw={},scope,now=Date.now(),params=defaults}={}){
 const p=parameters(params),body=bodyClock(now),privateRoom=scope?.role==='owner'&&!scope.inherited&&!scope.conflict;
 const projected=projectAxes(raw,{now,session:scope?.session,params:p,allowed:privateRoom});
 const {activity,affect,diagnostics}=projected;
 const energy=activity.energy?.value??body.energy,stress=activity.stress?.value??20,curiosity=activity.curiosity?.value??50,social=activity.sociability?.value??50;
 // Small bounded competing tendencies; these are not hormones or mandatory behavior.
 const drives={rest:clamp((100-energy+stress*.2)*p.restBias,0,100),explore:clamp(curiosity*p.curiosityBias,0,100),connect:clamp(social*p.socialBias,0,100)};
 return {policy,body,activity,affect,drives,privateRoom,at:now,diagnostics};
}
export function choices(state,{incoming=false,proactiveAllowed=true,hasTopic=false,hasDiscovery=false}={}){
 if(!incoming&&!proactiveAllowed)return [{kind:'quiet',score:1,reason:'delivery_policy'}];
 const d=state.drives;
 const out=[{kind:incoming?'respond':'quiet',score:incoming?1:.5+d.rest/250}];
 if(hasTopic)out.push({kind:'continue_topic',score:.45+d.connect/250});
 if(hasDiscovery)out.push({kind:'public_discovery',score:.3+d.explore/250-d.rest/500});
 out.push({kind:'casual',score:.3+d.connect/250});
 return out.sort((a,b)=>b.score-a.score||a.kind.localeCompare(b.kind));
}
export function stateVoice(state){
 const pieces=[];
 if(state.body.phase==='night')pieces.push('模拟节律在夜间，精力基线稍低');
 const feeling=Object.values(state.affect).sort((a,b)=>b.value-a.value).slice(0,2).map(v=>v.label+(v.value>=50?'较明显':'还留着一点'));
 if(feeling.length)pieces.push('我最近表达过'+feeling.join('、'));
 const active=Object.entries(state.activity).filter(([k,v])=>Math.abs(v.value-axes[k][1])>=12).sort((a,b)=>Math.abs(b[1].value-axes[b[0]][1])-Math.abs(a[1].value-axes[a[0]][1])).slice(0,2);
 for(const [k,v] of active)pieces.push('我'+v.label+(v.value>axes[k][1]?'的倾向高些':'的倾向低些'));
 return (pieces.join('；')||'没有足够新证据表明状态明显偏离平常').slice(0,limits.stateChars);
}
// Forgetting is attention decay only. Explicit corrections stay protected; no deletion/reinforcement on read.
export function memoryWeight(item,now,params=defaults){
 if(item.kind==='correction'||item.kind==='preference')return 1;
 const at=item.sourceTime;if(!Number.isFinite(at)||at>now)return .25;
 return Math.max(.05,2**(-(now-at)/(parameters(params).memoryHalfDays*86400000)));
}
export function compilePacket({state,memories=[],candidates=[],associations=[],expression={},appraisal={},now=state.at,params=defaults}={}){
 const header='【星河·当下状态】程序模拟与可见记录，不是新来信、已发生的经历或必须照说的台词。状态仅供选择，当前原话与自主判断优先。\n';
 const body={},hasAppraisal=Object.keys(appraisal).length>0;
 const stateText=state.body.phase==='night'||Object.keys(state.affect).length||Object.keys(state.activity).length?stateVoice(state):null;
 if(stateText&&!hasAppraisal)body.状态=stateText;
 if(candidates.length)body.可选方向=candidates.slice(0,2).map(x=>({respond:'回应当前来信',quiet:'安静',continue_topic:'接已有话题',public_discovery:'聊已读到的公开发现',casual:'随意聊聊'})[x.kind]);
 // Reserve bounded space for current event and durable relationship evidence.
 const appraisalBudget=memories.length?780:limits.packetChars;
 const fitAppraisal=(key,value)=>{
  if(value&&(header+JSON.stringify({...body,[key]:value})).length<=appraisalBudget){body[key]=value;return true;}return false;
 };
 fitAppraisal('当下来意',appraisal.当下来意);
 const relation=appraisal.关系依据;
 if(relation&&Array.isArray(relation.原话)){
  const kept=[];
  for(const row of relation.原话.slice(0,2))if(fitAppraisal('关系依据',{性质:relation.性质,原话:[...kept,row]}))kept.push(row);
 }
 for(const key of ['可能反应','前事余留'])fitAppraisal(key,appraisal[key]);
 if(stateText&&hasAppraisal)fitAppraisal('状态',stateText);
 const seen=new Set();
 const ranked=memories.filter(m=>m&&typeof m.quote==='string'&&typeof m.sourceMessageId==='string').map((m,i)=>({m,i,w:Number.isInteger(m.attentionRank)&&m.attentionRank>=0&&m.attentionRank<4?1-m.attentionRank/10:memoryWeight(m,now,params)})).sort((a,b)=>b.w-a.w||a.i-b.i);
 const refs=[];
 for(const {m} of ranked){
  if(refs.length>=limits.memoryItems||seen.has(m.sourceMessageId))continue;
  const quote=m.evidenceQuote||m.quote;
  const item={来源:m.sourceMessageId,时间:m.sourceTime??null,原话:quote.slice(0,limits.memoryQuoteChars),截断:quote.length>limits.memoryQuoteChars||m.partial===true};
  if((header+JSON.stringify({...body,历史原话:[...refs,item]})).length>limits.packetChars)continue;
  refs.push(item);seen.add(m.sourceMessageId);
 }
 if(refs.length)body.历史原话=refs;
 const add=(key,value)=>{if(value&&(header+JSON.stringify({...body,[key]:value})).length<=limits.packetChars)body[key]=value};
 if(associations.length)add('可选联想',associations.slice(0,1));
 for(const [key,value] of Object.entries(expression))add(key,value);
 const text=header+JSON.stringify(body);if(text.length>limits.packetChars)throw Error('Tidal packet budget');
 return {text,stats:{policy,characters:text.length,memoryItems:refs.length,emotionAxes:Object.keys(state.affect),activityAxes:Object.keys(state.activity),associations:body.可选联想?.length||0,expressionHints:Number(!!body.近期重复),expressionExamples:Number(!!body.表达参考),appraisalFields:Object.keys(appraisal).filter(k=>Object.hasOwn(body,k)),appraisalOmitted:Object.keys(appraisal).filter(k=>!Object.hasOwn(body,k)),relationshipItems:body.关系依据?.原话.length||0,stateIncluded:!!body.状态,modelCallsAdded:0}};
}
