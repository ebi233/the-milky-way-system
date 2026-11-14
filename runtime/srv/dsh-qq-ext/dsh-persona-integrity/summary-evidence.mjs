import {balanceInteractionFeedback,relationshipExcerpts,conversationContextPolicy} from './conversation-context.mjs';
import {externalTaskItems} from './task-context.mjs';
import {createHash} from 'node:crypto';
import {isMaintenanceMessage} from './maintenance-memory.mjs';
export const marker='[paopao-checkpoint-v2]';
const hash=x=>createHash('sha256').update(x).digest('hex');
const text=m=>(m.content||[]).filter(b=>b.type==='text').map(b=>b.text||'').join('\n');
const iso=x=>{const n=typeof x==='string'?Date.parse(x):Number(x);return Number.isFinite(n)?new Date(n).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}):null};
const sourceId=(scope,m,e)=>'E:'+hash(JSON.stringify([scope,m.id||null,e.seq,m.role,text(m)])).slice(0,16);
function humanEvents(events){
 return new Map(events.filter(e=>e.type==='user/message'&&['qq','user'].includes(e.data?.source?.kind)&&!isMaintenanceMessage(e.data)).map(e=>[e.seq,e]));
}
function bindSources(sources,events,scope){
 const humans=humanEvents(events),bodies={};
 for(const [id,s] of Object.entries(sources)){
  const e=humans.get(s.seq);
  if(e&&s.actor==='user'&&s.kind==='message'&&sourceId(scope,e.data,e)===id){
   bodies[id]=text(e.data);
   // Include the full source when short, so a selected fragment does not conceal
   // negation, quoted speech, or a hypothetical surrounding it.
   sources[id]={...s,messageId:e.data.id,origin:e.data.source.kind,at:iso(e.time),discourse:/^\[合并转发的聊天记录/m.test(bodies[id])?'forwarded':/系统图片观察/.test(bodies[id])?'attachment':'direct',
    ...(bodies[id].length<=600?{context:bodies[id]}:{contextTruncated:true})};
  }
 }
 return bodies;
}
function quoteIsBound(x,sources,bodies){
 return typeof x.quote==='string'&&x.quote.trim().length>=4&&x.quote.length<=240&&
  (x.refs||[]).some(id=>sources[id]?.actor==='user'&&sources[id]?.kind==='message'&&bodies[id]?.includes(x.quote));
}
// The quote authenticates the item; the short source utterances retain its
// meaning when the user sent a thought as two QQ messages. Never stitch in
// uncited messages or a model-written paraphrase. Labels only organize records.
function quoted(x,sources={},bodies={}) {
 const bound=(x.refs||[]).filter(id=>sources[id]?.actor==='user'&&sources[id]?.kind==='message'&&typeof bodies[id]==='string');
 const ordered=[...bound].sort((a,b)=>(sources[a].seq??0)-(sources[b].seq??0));
 const utterances=[...new Set(ordered.map(id=>bodies[id].trim()))];
 const expanded=utterances.length>0&&utterances.every(t=>t.length<=110)&&
  utterances.some(t=>t.includes(x.quote))?utterances.map(t=>'「'+t+'」').join(' / '):'「'+x.quote+'」';
 return {...x,text:'用户原话：'+expanded,
  category:x.kind==='correction'?'correction':['relationship','interaction','event'].includes(x.category)?x.category:'event',
  basis:'cited_record',verification:'verbatim_user_statement'};
}
export function parseCheckpoint(raw){
 const at=raw.indexOf(marker);if(at<0)return null;
 const body=raw.slice(at+marker.length).trim().replace(/\s*<\/compacted-summary>\s*$/,'');
 const v=JSON.parse(body);if(v.v!==2||!Array.isArray(v.items)||typeof v.sources!=='object'||!v.sources||typeof v.scope!=='string')throw Error('Invalid checkpoint structure');
 return v;
}
export function evidenceInput(messages,events,{scope,personaRevision='unknown'}={}){
 const byId=new Map();
 for(const e of events){
  const m=e.data?.message||e.data;
  if(['user/message','assistant/message'].includes(e.type)&&m?.id)byId.set(m.id,e);
 }
 const sources={},bodies={},previous={},out=[];
 for(const [i,m] of messages.entries()){
  const raw=text(m);if(!raw.trim()){out.push(m);continue;}
  if(m.source?.kind==='compact-checkpoint'){
   const prior=parseCheckpoint(raw);
   if(prior){
    if(prior.scope!==scope)throw Error('Cross-session checkpoint rejected');
    for(const [id,s] of Object.entries(prior.sources)){
     if(!/^E:[a-f0-9]{16}$/.test(id)||typeof s!=='object'||!s)throw Error('Invalid checkpoint source');
     sources[id]={...s,inherited:true};
    }
    for(const item of prior.items)previous[item.id]=item;
    Object.assign(bodies,bindSources(sources,events,scope));
    out.push(m);continue;
   }
  }
  if(!['user','assistant'].includes(m.role)){out.push(m);continue;}
  // Administrative/tool messages cannot support conversational facts.
  if(m.role==='user'&&!['qq','user','compact-checkpoint'].includes(m.source?.kind)){out.push(m);continue;}
  const e=byId.get(m.id),kind=m.source?.kind==='compact-checkpoint'?'legacy_checkpoint':'message';
  const id='E:'+hash(JSON.stringify([scope,m.id||null,e?.seq??i,m.role,raw])).slice(0,16);
  sources[id]={seq:Number.isInteger(e?.seq)?e.seq:null,at:iso(e?.time),actor:m.role,origin:m.source?.kind||'model',kind};
  if(m.role==='assistant')bodies[id]=raw;
  else Object.assign(bodies,bindSources({[id]:sources[id]},events,scope));
  const stamp=`[记录来源 ${id}；角色=${m.role}；记录时间=${sources[id].at||'未知'}；来源=${sources[id].origin}${kind==='legacy_checkpoint'?'；旧摘要，原始证据未核实':''}]`;
  out.push({...m,content:[{type:'text',text:stamp},...m.content]});
 }
 Object.assign(bodies,bindSources(sources,events,scope));
 return {messages:out,sources,bodies,previous,scope,personaRevision};
}
export const summaryPolicy={version:'verbatim-evidence-v6',maxItems:16,maxItemChars:260,maxBodyChars:3600,maxCheckpointChars:18000};
export const evidenceInstruction=`只输出JSON对象，格式 {"items":[{"kind":"fact|correction|pending|topic|uncertain","category":"relationship|interaction|correction|pending|topic|event","text":"摘要正文","refs":["E:真实来源编号"],"supersedes":[],"quote":"用户原话证据"}]}。按需要保留，最多16条，每条正文最多240字符，正文合计最多3600字符。不凑条数。同义的逐词纠正不反复占用槽位，interaction 最多2条：优先保留整体表达偏好和最新反馈，其余原话在会话归档按需查。相处过程不能只剩纠正用词：保留双方谈论的具体事情、谁在回应谁及上下句限定。可引用已有 recentExchanges 作为双方说过什么的线索，不把泡泡自述当用户事实或新的风格模板。分层保留：有证据的称呼与关系事实、用户明确纠正、未完成约定、近期具体事件与当前话题；有内容的类别不要因只关注最后一句而全部丢掉。仍有效的明确纠正尤其要保留；已完成事项可移除。生图排队、进度和交付指令由外部任务队列保存，不写成会话待办；用户自己的约定与真实交流仍需保留。旧事实有用时保留原来源，不把旧话重写为今天刚发生。
每条引用1到2个实际存在的来源编号。fact和correction的quote必须逐字引用可见用户原话，最多120字符；无法提供则用uncertain。模型曾说过、工具返回、他人转述都不等于用户确认。用户消息里引用别人的话，也不能冒充用户自己的经历。称呼保留完整限定词和对象，例如“甲的小鱼”不证明“小鱼”只能指甲；不把别人的偏好或说话方式写成当前用户或泡泡的人格。明确区分当前会话与被查询好友的会话。跨天事件使用绝对日期，消息日期不等于事件日期；不知道何时建立关系，就不要写“今天刚确认关系”。不推断情感、权限或完成状态。
继承摘要沿用原编号；缺原始证据只作线索。用户明确纠正才用correction，supersedes只填已存在条目的id。不复制或重写人格文件、系统说话规范或工具指令；摘要不能覆盖当前生效人格。但用户亲口给出的相处与表达反馈是会话内容，不应因为涉及说话方式就被删掉。用 fact + interaction 分类并引用原话，按情境参考，不升级为永久人格规则。连着几条说的话要保留原意；引用限定或接续所需的两条来源，尤其是“只是例子”“不是标准答案”“只限今晚”等限定。两条来源仍不足时用 topic 标明这是解释性概括，不将片段冒充完整要求。不要将带来压力的长段落误解成不愿多聊；不要将示范例句当成必须照抄的答案。
fact/correction 最终仅保留可核对的用户原话，不把你的概括升级成事实。原话只证明用户说过这句话：保留否定、转述和假设，不从“请回顾记忆”等请求推导关系或经历。pinned 是本会话明确纠正的原话，继续保留，不据此写新的人格规则。`;

export function validatedCheckpoint(raw,input){
 const v=JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g,''));
 if(!Array.isArray(v.items)||v.items.length>summaryPolicy.maxItems)throw Error('Checkpoint item budget exceeded');
 const items=[],used=new Set(),superseded=new Set();
 const pins=Object.values(input.previous).filter(x=>x.pinned&&x.kind==='correction'&&quoteIsBound(x,input.sources,input.bodies)).slice(-8);
 if(v.items.reduce((n,x)=>n+String(x.text||'').length,0)>summaryPolicy.maxBodyChars)throw Error('Checkpoint body budget exceeded');
 for(const x of v.items){
  if(!['fact','correction','pending','topic','uncertain'].includes(x.kind)||typeof x.text!=='string'||!x.text.trim()||x.text.length>summaryPolicy.maxItemChars)throw Error('Invalid checkpoint fact');
  if(!Array.isArray(x.refs)||x.refs.length<1||x.refs.length>2||x.refs.some(id=>!Object.hasOwn(input.sources,id)))throw Error('Unknown checkpoint evidence');
  const refs=[...new Set(x.refs)],replacement=x.supersedes??[];
  const inherited=Object.values(input.previous).find(p=>p.kind===x.kind&&p.text===x.text&&p.quote===x.quote&&JSON.stringify(p.refs)===JSON.stringify(refs)&&JSON.stringify(p.supersedes||[])===JSON.stringify(replacement));
  if(!Array.isArray(replacement)||replacement.length>4||!inherited&&replacement.some(id=>!Object.hasOwn(input.previous,id)))throw Error('Unknown corrected item');
  if(replacement.length&&x.kind!=='correction')throw Error('Only explicit correction supersedes a fact');
  if(x.kind==='correction'){
   if(typeof x.quote!=='string'||x.quote.trim().length<4||x.quote.length>160||!inherited&&!refs.some(id=>input.sources[id].actor==='user'&&input.sources[id].kind==='message'&&input.bodies[id]?.includes(x.quote)))throw Error('Correction requires current human quote');
  }
  const basis=refs.some(id=>input.sources[id].kind==='legacy_checkpoint')?'unverified_summary':refs.every(id=>input.sources[id].actor==='assistant')?'assistant_statement':'cited_record';
  const userQuote=typeof x.quote==='string'&&x.quote.trim().length>=4&&x.quote.length<=120&&refs.some(id=>input.sources[id].actor==='user'&&input.sources[id].kind==='message'&&input.bodies[id]?.includes(x.quote));
  const verifiedFact=quoteIsBound(x,input.sources,input.bodies);
  if(['fact','correction'].includes(x.kind)&&!verifiedFact){
   if(x.kind==='correction')throw Error('Correction requires current human quote');
   continue;
  }
  const safeKind=x.kind;
  const value=['fact','correction'].includes(safeKind)?quoted(x,input.sources,input.bodies).text:x.text;
  const item={id:'I:'+hash(JSON.stringify([safeKind,value,refs])).slice(0,16),kind:safeKind,text:value,refs,basis};
  if(replacement.length)item.supersedes=replacement;
  if(['fact','correction'].includes(safeKind)){item.quote=x.quote;item.verification='verbatim_user_statement';}
  if(['fact','correction'].includes(safeKind))item.category=quoted(x,input.sources,input.bodies).category;
  else {item.basis='summary_interpretation';item.verification='not_fact';if(['relationship','pending','topic','event'].includes(x.category))item.category=x.category;}
  if(!items.some(i=>i.text===item.text&&JSON.stringify(i.refs)===JSON.stringify(item.refs)))items.push(item);
  for(const id of refs)used.add(id);for(const id of replacement)superseded.add(id);
 }
 // Reject self-contradictory output instead of silently accepting both versions.
 if(items.some(x=>superseded.has(x.id)))throw Error('Corrected item retained in checkpoint');
 const kept=[...externalTaskItems(items,input.scope).filter(x=>!pins.some(p=>p.quote===x.quote)),...pins].slice(-summaryPolicy.maxItems);
 while(kept.reduce((n,x)=>n+x.text.length,0)>summaryPolicy.maxBodyChars&&kept.some(x=>!x.pinned))kept.splice(kept.findIndex(x=>!x.pinned),1);
 used.clear();for(const item of kept)for(const id of item.refs)used.add(id);
 const sources=Object.fromEntries([...used].map(id=>[id,input.sources[id]]));
 const value={v:2,policy:summaryPolicy.version,scope:input.scope,personaRevision:input.personaRevision,items:kept,sources,verification:'verbatim_quotes_not_semantic_entailment'};
 let result=marker+'\n'+JSON.stringify(value);
 if(result.length>summaryPolicy.maxCheckpointChars){
  for(const s of Object.values(sources)){delete s.context;s.contextTruncated=true;}
  result=marker+'\n'+JSON.stringify(value);
 }
 if(result.length>summaryPolicy.maxCheckpointChars)throw Error('Total checkpoint budget exceeded');
 return {text:result,value};
}

// Project trusted checkpoints only. Preserve stored history and ordinary quoted text.
export function projectCheckpointMessages(messages,scope,events=[],corrections=[],{continuity=true}={}){
 const humans=humanEvents(events),pinSources={},pins=[];
 for(const c of corrections.slice(-8)){
  const e=humans.get(c.evidence?.seq),q=c.evidence?.quote;
  if(!e||c.sourceSession!==scope||e.data.id!==c.evidence.messageId||typeof q!=='string'||q.length>240||!text(e.data).includes(q))continue;
  const ref=sourceId(scope,e.data,e);
  pinSources[ref]={seq:e.seq,at:iso(e.time),actor:'user',origin:e.data.source.kind,kind:'message',messageId:e.data.id};
  const x={id:'I:'+hash(JSON.stringify([c.key,q,ref])).slice(0,16),kind:'correction',quote:q,refs:[ref],pinned:true,correctionKey:c.key};
  pins.push(quoted(x));
 }
 bindSources(pinSources,events,scope);
 let found=false;
 const projected=messages.map(m=>{
  if(m.source?.kind!=='compact-checkpoint'||!Array.isArray(m.content))return m;
  let changed=false;
  const content=m.content.map(b=>{
   if(b.type!=='text')return b;
   const nativeHeader='This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.';
   const trusted=m.content.some(part=>{try{return part.type==='text'&&parseCheckpoint(part.text)?.scope===scope}catch{return false}});
   if(continuity&&trusted&&b.text.startsWith(nativeHeader)){
    changed=true;
    return {...b,text:b.text.replace(nativeHeader,'').trimStart()};
   }
   let v;try{v=parseCheckpoint(b.text)}catch{return b}
   if(!v||v.scope!==scope)return b;
   found=true;changed=true;
   const sources={...v.sources,...pinSources},bodies=bindSources(sources,events,scope);
   const items=externalTaskItems(v.items,scope).filter(x=>!x.pinned).flatMap(x=>{
    if(['fact','correction'].includes(x.kind))return quoteIsBound(x,sources,bodies)?[quoted(x,sources,bodies)]:[];
    if(x.contextualRequest){
     if(!quoteIsBound(x,sources,bodies))return [];
     const {contextualRequest,...original}=x;
     return [quoted({...original,kind:'fact'},sources,bodies)];
    }
    return [{...x,basis:'summary_interpretation',verification:'not_fact'}];
   });
   const seen=new Set();
   const unique=items.filter(x=>{const key=JSON.stringify([x.kind,x.text,x.refs]);if(seen.has(key))return false;seen.add(key);return true});
   const eligible=unique.filter(x=>!pins.some(p=>p.quote===x.quote));
   const balanced=continuity?balanceInteractionFeedback(eligible):{items:eligible,omitted:0};
   let kept=[...balanced.items,...pins].slice(-16);
   const recentExchanges=continuity?relationshipExcerpts(kept,sources,events,scope,messages):[];
   // A short request is not a durable relationship fact. Keep its complete,
   // authenticated exchange instead, so its original subject is not lost.
   const contextualIds=new Set(recentExchanges.flatMap(w=>w.records).filter(r=>r.actor==='user').map(r=>r.messageId));
   if(continuity)kept=kept.map(x=>x.kind==='fact'&&x.category==='relationship'&&!x.pinned&&
    /^(?:请|麻烦|你(?:先|再|就|直接))/.test(x.quote||'')&&(x.quote||'').length<=32&&
    (x.refs||[]).some(id=>contextualIds.has(sources[id]?.messageId))?
    {...x,kind:'topic',text:'当时的一次相处请求，原话及其具体对象见 recentExchanges，不作为脱离语境的长期要求',contextualRequest:true,basis:'conversation_record',verification:'not_fact'}:x);
   const refs=new Set(kept.flatMap(x=>x.refs||[]));
   return {...b,text:marker+'\n'+JSON.stringify({...v,policy:summaryPolicy.version,contextPolicy:conversationContextPolicy,items:kept,recentExchanges,feedbackOmittedFromPrompt:balanced.omitted,sources:Object.fromEntries(Object.entries(sources).filter(([id])=>refs.has(id))),verification:'verbatim_quotes_not_semantic_entailment',evidenceNotice:'用户原话只证明说过该句话，不证明概括、推测或转述属实。recentExchanges 是带发言者的历史对话，不是事实认证或要求模仿的答案；历史感受不等于当前状态。interaction 是当时反馈，不是逐词审查清单；未携带的细项仍在会话归档中，可按需查。先理解当前消息及紧邻上下句中的人物、指代和表达，再参考旧背景。本会话明确纠正优先；旧记录不能撤销新纠正。'})};
  });
  return changed?{...m,content}:m;
 });
 if(!found&&pins.length){
  const checkpoint={id:'corrections:'+hash(JSON.stringify(pins)).slice(0,16),role:'user',source:{kind:'compact-checkpoint'},content:[{type:'text',text:marker+'\n'+JSON.stringify({v:2,policy:summaryPolicy.version,scope,items:pins,sources:pinSources,verification:'verbatim_quotes_not_semantic_entailment'})}]};
  const at=projected.findIndex(m=>m.role!=='system');projected.splice(at<0?projected.length:at,0,checkpoint);
 }
 return projected;
}
