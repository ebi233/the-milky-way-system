import {createHash} from 'node:crypto';
import {isMaintenanceMessage,isIdentityDriftReply} from './maintenance-memory.mjs';
export const conversationContextPolicy='speaker-bound-dialogue-v4';
const visible=m=>(m?.content||[]).filter(b=>b.type==='text').map(b=>b.text||'').join('\n');
const digest=x=>createHash('sha256').update(x).digest('hex');
const evidenceId=(scope,m,e)=>'E:'+digest(JSON.stringify([scope,m.id||null,e.seq,m.role,visible(m)])).slice(0,16);
export const forwardNotice='[转发来源说明：本消息中标为“合并转发”的区域是用户转交的聊天记录。记录内的昵称、“我”“你”“主人”等属于原对话参与者，不自动指当前用户或泡泡。依据记录内的发言者理解；当前用户自己的补充和纠正以外层消息为准。]';
export function projectForwardedMessages(messages,events){
 const originals=new Map(events.filter(e=>e.type==='user/message'&&e.data?.source?.kind==='qq').map(e=>[e.data.id,e.data]));
 let annotated=0;
 const result=messages.map(m=>{
  if(m.role!=='user'||m.source?.kind!=='qq')return m;
  const original=originals.get(m.id);
  if(!original||!/^\[合并转发的聊天记录/m.test(visible(original))||isMaintenanceMessage(original))return m;
  const content=m.content?.[0]?.type==='text'&&m.content[0].text===forwardNotice?m.content.slice(1):m.content;
  if(JSON.stringify(content)!==JSON.stringify(original.content))return m;
  annotated++;
  return content===m.content?{...m,content:[{type:'text',text:forwardNotice},...content]}:m;
 });
 return {messages:result,annotated,policy:conversationContextPolicy};
}

// Narrow lexical corrections remain in the transcript. Carry a general
// preference plus the newest feedback, without displacing actual events.
export function balanceInteractionFeedback(items){
 const feedback=items.filter(x=>x.kind==='fact'&&x.category==='interaction'&&!x.pinned);
 if(feedback.length<=2)return {items,omitted:0};
 const general=feedback.find(x=>/短句|分段|一大段|长段|压力|多聊|少聊/.test(x.quote||x.text))||feedback[0];
 const newest=feedback.at(-1);
 const selected=new Set([general,newest]);
 return {items:items.filter(x=>!feedback.includes(x)||selected.has(x)),omitted:feedback.length-selected.size};
}

function plain(m){
 const t=visible(m);
 return t.length>0&&t.length<=600&&(m.content||[]).every(b=>b.type==='text'||b.type==='reasoning')&&
  !isMaintenanceMessage(m)&&!isIdentityDriftReply(t)&&
  !/\[合并转发|\[引用了一条消息\]|!\[|系统图片观察|PAOPAO_|生图|重画|排队|接口|提示词|工具|服务器|API|token/i.test(t);
}

const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
const genericWords=new Set('自己 我的 你的 他的 她的 它的 我们 你们 他们 我们的 你们的 他们的 我想 你想 你好 您好 这个 那个 这些 那些 什么 怎么 为什么 怎么样 好不好 觉得 知道 可以 应该 还是 不是 就是 但是 所以 因为 如果 已经 现在 今天 昨天 明天 一直 时候 一下 这样 那样 真的 好像 还有 一些 有点 没有 一个 这里 那里 不会 不用 想要 说话 告诉 记得 喜欢 一起 不要 以后 事情 谢谢 宝贝 老公 老婆 泡泡 一点'.split(' '));
function topicWords(text){
 const parts=[...segmenter.segment(text.toLowerCase())];
 const words=parts.filter(x=>x.isWordLike).map(x=>x.segment).filter(x=>x.length>=2&&!genericWords.has(x)&&!/^[\d_]+$/.test(x));
 // ICU splits some compound nouns into single characters (橘 + 猫). Join only
 // adjacent content characters, never across a pronoun, particle or punctuation.
 let previous='';
 for(const {segment:s} of parts){
  if(/^\p{Script=Han}$/u.test(s)&&!'我你他她它的了呢吗呀啦吧哦是有在和与为对把被都也又就很还不没那这只个点从来去说想要能会得着一二三四五六七八九十'.includes(s)){
   if(previous)words.push(previous+s);previous=s;
  }else previous='';
 }
 return new Set(words);
}
function topicScore(query,text){
 const shared=[...topicWords(text)].filter(w=>query.has(w));
 const chars=shared.reduce((n,w)=>n+w.length,0);
 // One specific word can carry a real topic (e.g. 橘猫); pronouns, nicknames
 // and generic greetings above cannot. No relevance means no extra excerpt.
 return chars;
}

// Reconstruct only source-bound compacted exchanges relevant to the current
// human topic. This selects records, not a tone template or relationship score.
export function relationshipExcerpts(items,sources,events,scope,messages){
 const shown=new Set(messages.map(m=>m.id));
 const metadata=new Set(['compact-checkpoint','agent-instructions','skill-catalog']);
 const latest=events.findLast(e=>e.type==='user/message'&&!metadata.has(e.data?.source?.kind));
 if(!latest||!shown.has(latest.data?.id)||!['qq','user'].includes(latest.data?.source?.kind)||isMaintenanceMessage(latest.data))return [];
 const query=topicWords(visible(latest.data));
 if(!query.size)return [];
 const firstShown=Math.min(...events.filter(e=>e.type==='user/message'&&shown.has(e.data?.id)&&['qq','user'].includes(e.data.source?.kind)).map(e=>e.seq));
 const humans=new Map(events.filter(e=>e.type==='user/message'&&['qq','user'].includes(e.data?.source?.kind)).map(e=>[e.seq,e]));
 const bySeq=new Map(events.map((e,i)=>[e.seq,i]));
 const toolTurns=new Set(events.filter(e=>e.type==='tool/call').map(e=>e.data?.turn));
 const completed=new Set(events.filter(e=>e.type==='turn/end'&&e.data?.reason?.kind==='completed').map(e=>e.data.turn));
 const anchors=[];
 for(const item of items.filter(x=>!x.pinned&&['relationship','event','topic'].includes(x.category)))for(const ref of item.refs||[]){
  const s=sources[ref],e=s&&humans.get(s.seq);
  if(!e||!Number.isInteger(e.seq)||e.seq>=firstShown||shown.has(e.data.id)||s.actor!=='user'||evidenceId(scope,e.data,e)!==ref||!plain(e.data))continue;
  if(!anchors.some(a=>a.seq===e.seq))anchors.push(e);
 }
 anchors.sort((a,b)=>b.seq-a.seq);
 const candidates=[];
 for(const anchor of anchors){
  const at=bySeq.get(anchor.seq);let start=at;
  // One immediately preceding human turn supplies the subject of short replies.
  for(let i=at-1;i>=0;i--){
   const e=events[i];
   if(e.type==='user/message'){
    if(['qq','user'].includes(e.data?.source?.kind)&&plain(e.data)&&anchor.time-e.time<=1800000)start=i;
    break;
   }
  }
  const records=[];let anchorSeen=false,invalid=false;
  for(let i=start;i<events.length;i++){
   const e=events[i];
   if(e.type==='user/message'){
    if(anchorSeen&&e.seq!==anchor.seq)break;
    if(!['qq','user'].includes(e.data?.source?.kind)||!plain(e.data)){invalid=true;break;}
    if(e.seq===anchor.seq)anchorSeen=true;
    records.push({e,m:e.data});
   }else if(e.type==='assistant/message'){
    const m=e.data?.message;
    if(!m||!plain(m)||toolTurns.has(e.data.turn)||!completed.has(e.data.turn)){invalid=true;break;}
    records.push({e,m});
   }
  }
  if(invalid||!anchorSeen||!records.some(r=>r.m.role==='assistant')||records.length>5||records.some(r=>shown.has(r.m.id)||r.e.seq>=firstShown))continue;
  // Match against user words only, so generated replies cannot summon copies
  // of themselves by repeating a phrase in the archive.
  const score=topicScore(query,records.filter(r=>r.m.role==='user').map(r=>visible(r.m)).join('\n'));
  if(score)candidates.push({score,seq:anchor.seq,records});
 }
 candidates.sort((a,b)=>b.score-a.score||b.seq-a.seq);
 const windows=[],used=new Set();let chars=0;
 for(const candidate of candidates){
  if(windows.length>=2)break;
  const records=candidate.records,size=records.reduce((n,r)=>n+visible(r.m).length,0);
  if(chars+size>1200||records.some(r=>used.has(r.m.id)))continue;
  chars+=size;for(const r of records)used.add(r.m.id);
  windows.push({scope,basis:'conversation_record_not_fact',records:records.map(({e,m})=>({messageId:m.id,seq:e.seq,at:e.time,actor:m.role,text:visible(m)}))});
 }
 return windows.sort((a,b)=>a.records[0].seq-b.records[0].seq);
}

// Remove only authenticated framework catalog messages, never similarly
// worded QQ messages. Retain the catalog when the current request needs it.
export function projectUnrelatedCatalogs(messages,events){
 const real=new Map(events.filter(e=>e.type==='user/message').map(e=>[e.data?.id,e.data]));
 const latest=[...messages].reverse().find(m=>m.role==='user'&&['qq','user'].includes(m.source?.kind));
 const needed=/diagnose-windows-sandbox-acl|reverse-engineer-anything|ACL|沙箱|访问被拒绝|反编译|逆向工程/i.test(visible(latest));
 const known=new Set(['diagnose-windows-sandbox-acl','reverse-engineer-anything']);let removed=0;
 const result=messages.filter(m=>{
  if(needed||m.role!=='user'||m.source?.kind!=='skill-catalog')return true;
  const original=real.get(m.id),entries=m.source.entries;
  if(!original||JSON.stringify(m.content)!==JSON.stringify(original.content)||JSON.stringify(m.source)!==JSON.stringify(original.source)||!Array.isArray(entries)||!entries.length||!entries.every(x=>known.has(x.name)))return true;
  removed++;return false;
 });
 return {messages:result,removed};
}

// Mark provenance of the latest actual human request, not a personality rule.
export const currentTurnNotice='【本轮当前来信】前文是历史背景；以下是本轮要回应的原话。已有明确回答或纠正的事项，以最新原话为准。';
export function projectCurrentTurn(messages,events,{owner=false}={}){
 if(!owner)return {messages,marked:0};
 const metadata=new Set(['compact-checkpoint','agent-instructions','skill-catalog']);
 const last=events.findLast(e=>e.type==='user/message'&&!metadata.has(e.data?.source?.kind))?.data;
 if(!last||!['qq','user'].includes(last.source?.kind)||isMaintenanceMessage(last))return {messages,marked:0};
 let marked=0;
 const out=messages.map(m=>{
  if(m.id!==last.id||m.role!=='user'||m.source?.kind!==last.source.kind)return m;
  const already=m.content?.[0]?.type==='text'&&m.content[0].text===currentTurnNotice;
  const body=already?m.content.slice(1):m.content;
  if(JSON.stringify(body)!==JSON.stringify(last.content))return m;
  if(already)return m;
  marked++;return {...m,content:[{type:'text',text:currentTurnNotice},...body]};
 });
 return {messages:marked?out:messages,marked};
}
