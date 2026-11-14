import {recallMatch,topicEnded,recentReplyTexts} from './recall-context.mjs';
import {parameters} from './state-kernel.mjs';
export const associationPolicy='xinghe-association-v2';
// A connection is a candidate between two pieces of text, never a new autobiographical fact.
export function associate(query,memories,{now=Date.now(),params={},recentMessages=[],queryContext=null}={}){
 if(topicEnded(query)||queryContext?.origin==='adjacent_human_topic')return [];
 const p=parameters(params),candidates=[],recent=recentReplyTexts(recentMessages);
 for(const m of memories.slice(0,4)){
  if(!['fact','topic','bookmark'].includes(m?.kind)||!m.sourceMessageId||typeof m.quote!=='string'||!Number.isFinite(m.sourceTime)||m.sourceTime>now||now-m.sourceTime>90*86400000||m.partial||String(query).includes(m.quote))continue;
  const quote=m.evidenceQuote||m.quote,match=recallMatch(query,quote);
  if(!match.relevant||match.score<p.associationMinOverlap||recent.some(t=>quote.length>=8&&t.includes(quote)))continue;
  candidates.push({kind:'possible_connection',sourceMessageId:m.sourceMessageId,sourceTime:m.sourceTime,quote,matched:match.matched.slice(0,4),basis:match.basis,concepts:match.concepts,count:match.score});
 }
 candidates.sort((a,b)=>b.count-a.count||b.sourceTime-a.sourceTime);
 return candidates.slice(0,1).map(({count,...m})=>({...m,quote:m.quote.slice(0,180),partial:m.quote.length>180}));
}
