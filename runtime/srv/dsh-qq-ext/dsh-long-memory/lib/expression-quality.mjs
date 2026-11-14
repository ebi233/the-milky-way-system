// Pure selection rules. No model calls, mutations, or persona instructions.
export const qualityPolicy='personal-dialogue-growth-v1';
// The human is already supplying the feedback in the current turn. An additional
// automatic lesson can distract from it and invite a report about the model's speech.
// This gates retrieval only; it never edits the human message or the reply.
export const currentStyleDiscussion=text=>/人机|伪人|八股|机械|生硬|僵硬|模板|像.{0,4}(?:助理|助手)|说话.{0,8}(?:冷|别扭|自然)|(?:解释|分析|检查|点评).{0,6}自己.{0,6}(?:说话|表达)/u.test(text||'')||
 /系统|模型|升级|上线|优化/u.test(text||'')&&/感觉|感受|变化|怎么样|如何|像你/u.test(text||'');
const feedback=/说话|语气|口语|用词|表达方式|这(?:个词|个字|句话|样说)|留白|八股|人机|伪人|客套|生硬|自然点|短句/;
const correction=/别(?:再|老|总|这么|这样)?说|不要.{0,8}(?:说|用)|不(?:太)?(?:会|该|要)用|不自然|人机|伪人|八股|客套|生硬|纠正|不是.{0,12}说法/;
const metaReply=/记(?:住|着|下)了|以后.{0,12}(?:说|用|改)|往后|我说话|我(?:会|得|要).{0,8}(?:注意|改正)|你的意思是|你(?:是在|是想)让我/;
const praise=/(?:这句|这段|这样说|刚才说的|刚才那句|刚才说得).{0,16}(?:自然|喜欢|好听|有意思|像你|很棒)|(?:喜欢|爱听).{0,8}(?:这句|这段|这样说)/;
export const isStyleFeedback=text=>feedback.test(text||'');
export const explicitApproval=text=>praise.test(text||'')&&!/(?:不|没|别).{0,4}(?:自然|喜欢|好听)|人机|生硬|机械|机器人|像客服|像助理|像助手|反话|反讽|讽刺|骗你的|才怪/.test(text||'');
export function exampleKind(ex){
 if(ex.kind==='owner_feedback')return 'preference';
 if(ex.kind==='public_excerpt')return 'public_reference';
 const humans=ex.records.filter(r=>r.role==='friend').map(r=>r.text);
 const replies=ex.records.filter(r=>r.role==='paopao').map(r=>r.text);
 if(!humans.length||!replies.length)return 'unsuitable';
 if(humans.some(t=>isStyleFeedback(t)||correction.test(t))||replies.some(t=>metaReply.test(t)))return 'correction_discussion';
 return 'dialogue';
}
export function approvedExample(ex){
 const a=ex.approval;
 return !ex.rejection&&exampleKind(ex)==='dialogue'&&a?.role==='friend'&&Boolean(a.messageId)&&
   Number.isFinite(a.seq)&&a.seq>Math.max(...ex.records.map(r=>r.seq??Infinity))&&explicitApproval(a.text);
}
export function learningProgress(e,{now=Date.now()}={}){
 const usable=(e.examples||[]).filter(x=>exampleKind(x)==='dialogue'&&!x.rejection),seen=new Set(),approved=[];
 for(const x of usable){
  if(!approvedExample(x)||!Number.isFinite(x.at)||x.at>now||now-x.at>=90*86400000||seen.has(x.approval.messageId)||x.records.some(r=>seen.has(r.messageId)))continue;
  seen.add(x.approval.messageId);for(const r of x.records)if(r.messageId)seen.add(r.messageId);approved.push(x);
 }
 const days=new Set(approved.map(x=>new Date(x.at+8*3600000).toISOString().slice(0,10)));
 const selected=e.adoption?.by==='paopao';
 return {stage:approved.length>=2&&days.size>=2?'established':approved.length?'situational':selected&&usable.length?'self_selected':'unadopted',independentApprovals:approved.length,independentDays:days.size,selfSelected:selected,automaticReinforcementOnRead:false};
}
export function expressionScenes(t){
 const result=[];
 for(const [scene,rx] of [['comfort',/难过|委屈|心烦|压力|沮丧|伤心|不开心|失落|好累/],['affection',/想你|抱抱|抱住|亲亲|亲一口|爱你|老婆|老公|怀里/],['playful',/哈哈|笑死|逗你|开玩笑|坏蛋|捉弄|嘿嘿/],['sharing',/分享|看到一个|发现一个|好有意思|刷到|推荐/],['greeting',/早安|晚安|早呀|睡醒|起床/],['daily',/吃(?:完|过|了|点|个)?饭|吃饱|干饭|午饭|晚饭|晚餐|回家|到家|回宿舍|散步|下班|上课|出门/]])if(rx.test(t))result.push(scene);
 return result;
}
const filler=/老哥|哥哥|老婆|老公|泡泡|浮鲸|哈哈|嘿嘿|今天|昨天|现在|刚才|一下|这个|那个|就是|还是|真的|已经|可以|自己|觉得|说话|表达|语气|日常|聊天|时候|不要|不用|喜欢/g;
const stop=new Set(['了一','一个','么了','去了','回来','的话','一下','怎么','什么','这样','这样说','以后','有点','一点','说的','我的','你的','不能','不是','不该','上了']);
function terms(text){
 const set=new Set();
 for(const part of String(text||'').toLowerCase().replace(filler,' ').match(/[\p{L}\p{N}]+/gu)||[]){
  if(/^[a-z0-9]+$/.test(part)){if(part.length>=3)set.add(part);continue;}
  for(let i=0;i<part.length-1;i++){const t=part.slice(i,i+2);if(!stop.has(t))set.add(t);}
 }
 return set;
}
export function topicScore(query,source){
 const a=terms(query),b=terms(source);return [...a].filter(t=>b.has(t)).length;
}
export function selectQuality(entries,query,session,{now=Date.now(),maxChars=600,recentMessages=[]}={}){
 if(currentStyleDiscussion(query))return [];
 const matches=[];
 const detailed=/详细|展开|完整|倾诉|长篇|多说|多讲|为什么|原理|分析|解释|教程|步骤|代码|报告|别.{0,8}短|不要.{0,8}短|不用.{0,8}短/.test(query);

 for(const e of entries){
  if(e.status!=='active'||!e.examples?.length||e.examples.some(x=>x.session!==session)||now-e.updatedAt>=90*86400000||e.updatedAt>now)continue;
  const progress=learningProgress(e,{now});
  for(const ex of e.examples){
   const kind=exampleKind(ex);
   // Corrections remain searchable preferences. Never mimic the apology or the model's lesson.
   if(kind==='preference'){
    const quote=ex.records.filter(r=>r.role==='friend').map(r=>r.text).join('\n');
    const score=topicScore(query,quote);
    if(detailed&&/短句|留白/.test(quote))continue;
    if(!isStyleFeedback(query)||score<1)continue;

    const item={kind:'preference',quote,source:ex.id};
    if(JSON.stringify(item).length<=maxChars)matches.push({item,score,at:e.updatedAt});
   }else if(exampleKind(ex)==='dialogue'&&!ex.rejection&&(approvedExample(ex)||progress.selfSelected)){
    if(!Number.isFinite(ex.at)||ex.at>now||now-ex.at>=90*86400000)continue;
    const source=ex.records.filter(r=>r.role==='friend').map(r=>r.text).join('\n');
    const score=topicScore(query,source),approved=approvedExample(ex);
    const sameScene=expressionScenes(query).includes(e.scene)&&expressionScenes(source).includes(e.scene);
    const expanded=progress.stage==='established'&&sameScene&&!detailed;
    if(score<(approved?2:3)&&!expanded)continue;
    const item={kind:'dialogue_example',example:ex.records.map(r=>({speaker:r.role==='friend'?'老哥':'泡泡',text:r.text})),source:ex.id,basis:approved?'explicit_owner_approval':'paopao_choice_not_owner_approval'};
    if(JSON.stringify(item).length<=maxChars)matches.push({item,score,at:e.updatedAt});
   }
   // Public material may still be collected and read voluntarily; no automatic imitation.
  }
 }
 matches.sort((a,b)=>b.score-a.score||b.at-a.at||a.item.source.localeCompare(b.item.source));
 return matches.slice(0,1).map(x=>x.item);
}
export function qualitySummary(e){
 const kinds=[...new Set(e.examples.map(exampleKind))];
 const growth=learningProgress(e);
 return {kinds,growth,automaticReference:growth.stage==='established'?'supported_scene_example':e.examples.some(approvedExample)?'topic_matched_example':growth.stage==='self_selected'?'self_selected_close_topic':kinds.every(k=>k==='preference')?'style_feedback_only':'manual_only'};
}
