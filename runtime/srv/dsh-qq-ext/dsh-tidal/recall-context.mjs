import {terms} from '../dsh-persona-integrity/attention-selection.mjs';
import {humanRecordText} from '../dsh-long-memory/lib/visible-records.mjs';
import {isMaintenanceMessage} from '../dsh-persona-integrity/maintenance-memory.mjs';

export const recallPolicy='bounded-topic-recall-v1';
// These are retrieval cues, not assertions that the phrases have the same meaning.
// Keep the small vocabulary tied to topics present in verified source quotes.
const concepts=[
 ['image_ratio',/画幅|长宽比|宽高比|(?:画面|图片|照片|相片)(?:的)?比例/u],
 ['self_address',/自称|称呼自己|叫自己/u],
 ['scheduled_reminder',/定时(?:任务|提醒)|每天提醒/u],
 ['show_picture',/(?:发|拍|看).{0,6}(?:照片|相片|图片|画像)|(?:照片|相片|图片|画像).{0,6}(?:给我看|发给我)/u],
];
const generic=new Set(['喜欢','希望','以后','需要','不需','主动','给我','给你','我看','自己','记得','记住','东西','不要','不能','不会','没有','一直','时候','这样','那样','已经','也会','所以','还有','你说','我说','知道','告诉','很多','说过','都是','你的','我的','再说','想要']);
const genericPattern=new RegExp([...generic,'可以','一起'].join('|'),'gu');
const lexical=s=>terms(String(s).replace(genericPattern,' '));
const labels=s=>new Set(concepts.filter(([,r])=>r.test(s)).map(([id])=>id));
export const topicEnded=s=>/(?:换个|换一个|换|换下)(?:话题|个话题)|(?:不聊|别聊|不谈|别提|不提|不说|别说)(?:这|那|了|旧|以前|过去)|到此为止|先这样|晚安|回头聊|再聊吧/u.test(s);
export const explicitRecall=s=>/还记得|记不记得|以前|之前|上次|原话|当时/u.test(s);
export function recallMatch(query,quote){
 const q=lexical(String(query).slice(0,1500)),s=lexical(String(quote).slice(0,800));
 const matched=[...s].filter(t=>q.has(t)),a=labels(String(query).slice(0,1500));
 const shared=[...labels(String(quote).slice(0,800))].filter(t=>a.has(t));
 return {matched:matched.slice(0,6),concepts:shared,overlap:matched.length,score:matched.length+shared.length*2,
  relevant:matched.length>=2||shared.length>0,basis:matched.length>=2?'shared_terms_not_semantic_proof':'bounded_phrase_cue_not_semantic_proof'};
}
const genericFollowup=s=>/^(?:那|嗯|好|哦|唔)?[，,\s]*(?:(?:这|那)(?:个|件事|一点)(?:呢|怎么样|怎么说|怎么选)|然后呢|继续(?:说|讲|聊)?|(?:再|多)?(?:讲|说)(?:一点|点|下去)|展开(?:讲讲|说说|讲|说)?|为什么(?:呢)?)[呀啊呢吧嘛~～。.!！?？\s]*$/u.test(s);
const plainHuman=m=>m?.role==='user'&&['qq','user'].includes(m.source?.kind)&&!isMaintenanceMessage(m)&&
 Array.isArray(m.content)&&m.content.every(b=>b.type==='text')&&!/合并转发|引用了一条消息|系统图片观察|系统文件|系统语音/.test(m.content.map(b=>b.text||'').join('\n'));
const time=v=>typeof v==='number'?v:typeof v==='string'?Date.parse(v):NaN;
// Only one adjacent human turn can provide a topic. Never recursively carry it on.
export function resolveRecallContext(query,messages,agent,{now=Date.now()}={}){
 const base={query:String(query).slice(0,1500),origin:'current',anchorMessageId:null,policy:recallPolicy};
 if(topicEnded(base.query)||!genericFollowup(base.query))return base;
 const tail=messages.slice(-16),current=tail.at(-1);
 if(!plainHuman(current)||humanRecordText(current)!==query)return base;
 let previous;
 for(let i=tail.length-2;i>=0;i--){
  const m=tail[i];
  if(m.role==='tool')return base;
  if(m.role==='user'){if(!plainHuman(m))return base;previous=m;break;}
 }
 if(!previous||!previous.id||!current.id||previous.id===current.id)return base;
 const anchor=humanRecordText(previous);
 if(!anchor||anchor.length>300||topicEnded(anchor)||genericFollowup(anchor))return base;
 // The request's trusted session events supply real timestamps. Unknown times fail closed.
 let events;try{events=agent?.session?.snapshotEvents?.()}catch{return base}
 if(!Array.isArray(events))return base;
 const found=new Map();
 for(const e of events.slice(-80)){
  if(e.type!=='user/message')continue;
  const m=e.data?.message||e.data;
  if((m?.id===current.id||m?.id===previous.id)&&plainHuman({...m,role:'user'}))found.set(m.id,{at:time(e.time??e.timestamp??e.at),text:humanRecordText(m)});
 }
 const a=found.get(previous.id),b=found.get(current.id);
 if(!a||!b||a.text!==anchor||b.text!==query||![a.at,b.at,now].every(Number.isFinite)||a.at>b.at||b.at>now||now-a.at>15*60000)return base;
 return {...base,query:anchor,origin:'adjacent_human_topic',anchorMessageId:previous.id};
}
export function recentReplyTexts(messages){
 // Only visible text from an adjacent dialogue, never tool output or synthetic references.
 const out=[];let turns=0;
 for(let i=messages.length-2;i>=Math.max(0,messages.length-16);i--){
  const m=messages[i];
  if(m.role==='tool')break;
  if(m.role==='user'){if(!plainHuman(m)||++turns>2)break;}
  if(m.role==='assistant'&&Array.isArray(m.content)&&m.content.every(b=>b.type==='text'))out.push(m.content.map(b=>b.text||'').join('\n').slice(0,3000));
 }
 return out.slice(0,2);
}
