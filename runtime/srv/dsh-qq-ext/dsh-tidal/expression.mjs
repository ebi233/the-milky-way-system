import {inspectRepetition} from '../dsh-persona-integrity/repetition-audit.mjs';
import {parameters} from './state-kernel.mjs';
import {currentStyleDiscussion} from '../dsh-long-memory/lib/expression-quality.mjs';
export const expressionPolicy='xinghe-expression-v4';
export function expressionSupport(messages,query,{scope,params={},example=''}={}){
 const p=parameters(params),audit=inspectRepetition(messages,{scope});
 if(currentStyleDiscussion(query))return {policy:expressionPolicy,data:{},observedTurns:audit.sampledTurns,repetitionHints:0,examples:0,modelCallsAdded:0,suppressed:'current_style_discussion'};
 const phrases=audit.candidates.filter(c=>c.needsReview&&c.count>=p.expressionRepeatThreshold&&!String(query).includes(c.phrase)).slice(0,2).map(c=>({片段:c.phrase,次数:c.count}));
 const out={};
 // Repetition stays observable; it no longer becomes a per-turn writing instruction.
 if(example){
  const start=example.indexOf('\n');
  try{
   const data=JSON.parse(example.slice(start+1));
   if(Array.isArray(data)&&data.length){
    const recent=messages.filter(m=>m.role==='assistant').slice(-6).map(m=>Array.isArray(m.content)?m.content.filter(b=>b.type==='text').map(b=>b.text||'').join('\n'):'').join('\n');
    const fresh=data.filter(item=>item.kind!=='dialogue_example'||!item.example?.some(r=>r.speaker==='泡泡'&&typeof r.text==='string'&&r.text.length>=4&&recent.includes(r.text))).slice(0,1);
    const blob=JSON.stringify(fresh);
    if(fresh.length&&blob.length<=650)out.表达参考={资料:fresh,含义:'资料保留当时的语境，按现在想说的意思回应；历史对话中的经历属于当时，无需复述资料或汇报学习'};
   }
  }catch{}
 }
 return {policy:expressionPolicy,data:out,observedTurns:audit.sampledTurns,repetitionHints:0,observedRepetitions:phrases.length,examples:out.表达参考?1:0,modelCallsAdded:0};
}
