import {projectVisibleEvents} from './visible-records.mjs';
import {explicitApproval} from './expression-quality.mjs';

export const learningPolicy='adjacent-visible-expression-feedback-v1';
export const explicitDisapproval=text=>/(?:这句|这段|这样说|刚才那句|刚才说的|你的回复).{0,24}(?:机械|人机|生硬|僵硬|别扭|不自然|不喜欢|太冷|像助手|像助理)|别这么说|不要这样说/u.test(text||'');
const time=e=>typeof e.time==='string'?Date.parse(e.time):Number(e.time??e.timestamp??e.at);
// No history file I/O: inspect at most two adjacent turns from a bounded in-memory tail.
export function feedbackWindow(events,session,{now=Date.now()}={}){
 if(!Array.isArray(events)||!Number.isFinite(now))return null;
 const tail=events.slice(-128),starts=tail.flatMap((e,i)=>e.type==='turn/start'?[i]:[]);
 if(starts.length<2)return null;
 const prior=tail[starts.at(-2)].data?.turn,current=tail[starts.at(-1)].data?.turn;
 const chunk=tail.slice(starts.at(-2)),currentEvents=tail.slice(starts.at(-1));
 const humans=currentEvents.filter(e=>e.type==='user/message'&&['qq','user'].includes((e.data?.message||e.data)?.source?.kind));
 if(humans.length!==1||currentEvents.some(e=>e.type==='tool/call'))return null;
 const h=humans[0],m=h.data?.message||h.data,raw=(m?.content||[]).filter(b=>b.type==='text').map(b=>b.text||'').join('\n');
 if(!m?.id||!Array.isArray(m.content)||m.content.some(b=>b.type!=='text')||raw.length>300||
  /合并转发|引用了一条消息|[“”「」"]|上次|昨天|以前|那天|不是.{0,8}(?:这句|刚才)/u.test(raw))return null;
 const positive=explicitApproval(raw),negative=explicitDisapproval(raw);
 if(positive===negative)return null;
 const at=time(h);if(!Number.isFinite(at)||at>now||now-at>10*60000)return null;
 let rows;try{rows=projectVisibleEvents([{type:'session',version:4,id:session},...chunk],session,{allowUserAfter:0,skipFirstUserTurn:true,plainDialogueOnly:true})}catch{return null}
 const previous=rows.filter(r=>r.turn===prior),feedback=rows.find(r=>r.turn===current&&r.role==='friend'&&r.messageId===m.id);
 if(!feedback||!previous.some(r=>r.role==='paopao')||previous.filter(r=>r.role==='friend').length!==1||previous.some(r=>r.at>at||at-r.at>10*60000))return null;
 return {kind:positive?'approval':'rejection',previous,feedback,session};
}

let last={policy:learningPolicy,status:'waiting',modelCallsAdded:0};
export const learningStatus=()=>last;
export function installExpressionLearning(ctx,observe){
 ctx.on('llm/stream',(options,next)=>{
  if(['agent','paopao-context-projected'].includes(options.purpose||'agent')&&options.sessionId){
   try{
    const agent=ctx.agents?.get(options.sessionId);
    if(agent){const result=observe(agent);if(result?.observed)last={policy:learningPolicy,at:Date.now(),...result,modelCallsAdded:0};}
   }catch{last={policy:learningPolicy,at:Date.now(),status:'unavailable',modelCallsAdded:0};}
  }
  return next();
 });
}
