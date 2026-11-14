import {createHash} from 'node:crypto';

// Observation only: never a prompt filter, rejection rule or rewrite trigger.
export const repetitionPolicy='bounded-chinese-repetition-observation-v1';
export const limits=Object.freeze({messages:80,turns:12,userChars:300,replyChars:400,gramMin:4,gramMax:8,candidates:5});
const hash=s=>createHash('sha256').update(s).digest('hex');
const words=new Intl.Segmenter('zh',{granularity:'word'});
const generic=new Set('自己 我的 你的 我们 你们 这个 那个 这些 那些 什么 怎么 为什么 怎么样 好不好 觉得 知道 可以 应该 还是 不是 就是 但是 所以 因为 如果 已经 现在 今天 昨天 明天 一直 时候 一下 这样 那样 真的 好像 还有 一些 有点 没有 一个 这里 那里 不会 不用 想要 说话 告诉 记得 喜欢 一起 不要 以后 事情 谢谢 宝贝 老公 老婆 泡泡 老哥 哥哥 嗯嗯 继续'.split(' '));
const greeting=/^(?:(?:老公|老婆|老哥|哥哥|泡泡))?(?:早上好|早安|晚安|晚上好|下午好|中午好|好梦|回头见|明天见)+(?:老公|老婆|老哥|哥哥|泡泡)?$/u;
function text(m,cap){
 let out='';
 for(const b of m?.content||[]){if(b.type==='text'&&typeof b.text==='string')out+=(out?'\n':'')+b.text.slice(0,cap-out.length);if(out.length>=cap)break;}
 return out;
}
function prose(t){
 // Quoted language and code are not evidence of an unprompted verbal habit.
 return t.replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)/g,' ')
  .replace(/`[^`\n]*(?:`|$)|“[^”]*(?:”|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|"[^"\n]*"/gu,' ')
  .replace(/^\s*(?:>|\[[^\]\n]*\]).*$/gm,' ')
  .replace(/https?:\/\/\S+/g,' ');
}
function topics(t){return new Set([...words.segment(prose(t))].filter(x=>x.isWordLike&&x.segment.length>=2&&!generic.has(x.segment)&&!/^[\d_]+$/.test(x.segment)).map(x=>x.segment));}

export function captureRepetitionInput(messages){
 return messages.slice(-limits.messages).map(m=>({id:m.id,role:m.role,source:{kind:m.source?.kind},
  content:[{type:'text',text:text(m,(m.role==='user'?limits.userChars:limits.replyChars)+1)}]}));
}

export function repetitionWindow(messages){
 const turns=[];let current=null,truncated=messages.length>limits.messages;
 for(const m of messages.slice(-limits.messages)){
  if(m.role==='user'&&['qq','user'].includes(m.source?.kind)){
   const raw=text(m,limits.userChars+1);if(raw.length>limits.userChars)truncated=true;
   if(current&&!current.reply){current.user=(current.user+'\n'+raw).slice(0,limits.userChars);current.id=m.id||current.id;}
   else{current={id:m.id||null,user:raw.slice(0,limits.userChars),reply:'',assistantIds:[]};turns.push(current);}
  }else if(m.role==='user'){
   // Framework or task messages break provenance; don't attach their replies to the preceding human.
   current=null;
  }else if(m.role==='assistant'&&current){
   const room=limits.replyChars-current.reply.length,raw=text(m,Math.max(1,room+1));
   if(raw.length>room)truncated=true;
   if(room>0)current.reply+=(current.reply?'\n':'')+raw.slice(0,Math.max(0,room-(current.reply?1:0)));
   if(m.id&&!current.assistantIds.includes(m.id)&&current.assistantIds.length<8)current.assistantIds.push(m.id);
  }
 }
 const complete=turns.filter(t=>t.reply.trim());
 return {turns:complete.slice(-limits.turns),truncated:truncated||complete.length>limits.turns};
}

export function inspectRepetition(messages,{scope=null}={}){
 const {turns,truncated}=repetitionWindow(messages),index=new Map();
 for(const [i,t] of turns.entries()){
  const unique=new Set();
  for(const run of prose(t.reply).matchAll(/\p{Script=Han}+/gu)){
   const chars=[...run[0]];
   for(let width=limits.gramMin;width<=limits.gramMax;width++)for(let at=0;at+width<=chars.length;at++){
    const phrase=chars.slice(at,at+width).join('');
    if(!greeting.test(phrase)&&!t.user.includes(phrase))unique.add(phrase);
   }
  }
  for(const phrase of unique){if(!index.has(phrase))index.set(phrase,[]);index.get(phrase).push(i);}
 }
 const required=Math.max(4,Math.ceil(turns.length*.4));
 const hits=[...index].filter(([,positions])=>positions.length>=required).sort((a,b)=>b[1].length-a[1].length||b[0].length-a[0].length||a[0].localeCompare(b[0]));
 const picked=[];
 for(const [phrase,positions] of hits){
  if(picked.some(x=>x.phrase.includes(phrase)&&x.positions.join(',')===positions.join(',')))continue;
  // Lexical diversity is only a conservative review hint, not semantic topic classification.
  const clusters=[];
  for(const i of positions){
   const ws=topics(turns[i].user);if(!ws.size)continue;
   // A bridging turn joins every matching cluster, preventing inflated diversity.
   for(let j=clusters.length-1;j>=0;j--)if([...ws].some(w=>clusters[j].has(w))){for(const w of clusters[j])ws.add(w);clusters.splice(j,1);}
   clusters.push(ws);
  }
  picked.push({phrase,positions,count:positions.length,rate:Number((positions.length/turns.length).toFixed(3)),topicHints:clusters.length,
   needsReview:clusters.length>=3,evidence:positions.map(i=>({userMessageId:turns[i].id,assistantMessageIds:turns[i].assistantIds}))});
  if(picked.length>=limits.candidates)break;
 }
 return {policy:repetitionPolicy,scope,sampledTurns:turns.length,truncated,ready:turns.length>=4,observationalOnly:true,
  candidates:picked.map(({positions,...x})=>x),modelCallsAdded:0};
}

export function redactRepetition(result){
 return {...result,candidates:result.candidates.map(({phrase,...r})=>({...r,phraseHash:hash(phrase),phraseChars:[...phrase].length}))};
}
