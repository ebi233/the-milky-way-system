// Design reference: SurfCore purpose-engine / PURPOSE_OUTREACH.
// Adapted to scoped conversation data, without shared role memory or extra LLM calls.
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {readObject,writeObject} from './runtime-state.mjs';
import {identity} from '../../dsh-qq-ext/dsh-long-memory/lib/access.js';
import {validateCandidate,safePublicText} from '../../dsh-qq-ext/dsh-public-social/social-policy.mjs';
const HOUR=3600000,DAY=24*HOUR;
const hash=v=>createHash('sha256').update(v).digest('hex');
const normalize=v=>String(v||'').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
const negative=t=>/(?:不想|不喜欢|没兴趣|不感兴趣|别再|别提|别聊|不要再|不聊|不提|算了)/.test(t);
const topicOf=t=>{
  if(negative(t))return null;
  const m=String(t).match(/(?:想了解|想研究|想学|想看看|最近在研究|最近在学|对(.{2,24}?)感兴趣|下次(?:再)?聊|改天(?:再)?聊|回头(?:再)?聊|想聊)([^\n。！？!?，,]{2,56})?/);
  const value=(m?.[1]||m?.[2]||'').trim().replace(/(?:吧|呀|啊|呢|嘛|~)+$/,'');
  return value.length>=2&&safePublicText(value,90)?value:null;
};
// Conservative lexical matching: never infer that an unrelated "no" rejects a goal.
export function mentions(topic,text){
  const a=normalize(topic),b=normalize(text);
  if(a.length<2)return false;
  if(b.includes(a))return true;
  if(a.length<4)return false;
  let hits=0,total=0;
  for(let i=0;i<a.length-2;i++){total++;if(b.includes(a.slice(i,i+3)))hits++;}
  return hits>=2&&hits/total>=.45;
}
export function scopeFor(agent,scope){
  const who=identity(agent);
  if(who.inherited||who.conflict||who.role!==(scope==='private'?'owner':scope==='group'?'group':'INVALID'))return null;
  const subject=String(who.qq||who.group||'');
  if(!subject||!who.session)return null;
  return {role:who.role,subject,session:who.session,key:hash(JSON.stringify([who.role,subject,who.session]))};
}
const active=g=>!['rejected','completed','expired','retired'].includes(g.status);
export function evolve(state,{messages=[],material=null,now=Date.now()}={}){
  const s=structuredClone(state);
  if(s.pending&&now-s.pending.at>20*60000){
    const g=s.goals.find(v=>v.id===s.pending.goalId);
    if(g){g.failures++;g.nextAt=now+HOUR;g.status=g.failures>=3?'retired':'active';}
    s.history.push({kind:'interrupted',at:now});s.pending=null;
  }
  for(const g of s.goals)if(active(g)&&now-g.updatedAt>7*DAY)g.status='expired';
  const seen=new Set(s.seen);
  for(const m of messages.slice(-12)){
    if(!m||!Number.isFinite(m.at)||m.at>now||now-m.at>DAY||typeof m.text!=='string')continue;
    const eid=hash(JSON.stringify([m.id||'',m.at,m.text]));if(seen.has(eid))continue;
    seen.add(eid);
    for(const g of s.goals){
      if(!active(g)||!mentions(g.topic,m.text))continue;
      if(negative(m.text)){
        g.status='rejected';g.updatedAt=now;g.feedback='explicit_rejection';
        s.history.push({kind:'rejected',at:now});
      }else if(/(?:看完|学会|弄懂|解决|完成)了/.test(m.text)){
        g.status='completed';g.updatedAt=now;g.feedback='explicit_completion';
        s.history.push({kind:'completed',at:now});
      }else if(g.lastSentAt&&m.at>g.lastSentAt&&/(?:有意思|感兴趣|喜欢|继续|想了解|想学|想聊)/.test(m.text)){
        g.status='active';g.updatedAt=now;g.feedback='positive';g.nextAt=Math.max(now+HOUR,g.nextAt||0);
        s.history.push({kind:'positive_feedback',at:now});
      }
    }
    const topic=topicOf(m.text);if(!topic)continue;
    const id=hash('conversation:'+normalize(topic)).slice(0,24),old=s.goals.find(g=>g.id===id);
    if(old){
      // A rejection is not silently overturned by the same historical material.
      if(active(old)){old.evidence=Math.min(8,old.evidence+1);old.updatedAt=now;}
    }else s.goals.push({id,topic,kind:'conversation',origin:'peer_interest',status:'active',createdAt:now,updatedAt:now,evidence:1,attempts:0,sent:0,failures:0,nextAt:now});
  }
  if(validateCandidate(material,now)){
    const eid='public:'+hash(material.id);
    if(!seen.has(eid)){
      seen.add(eid);
      const id=hash('public:'+normalize(material.title)).slice(0,24);
      if(!s.goals.some(g=>g.id===id))s.goals.push({id,topic:material.title.slice(0,90),kind:'discovery',origin:'public_candidate',status:'active',createdAt:now,updatedAt:now,evidence:1,attempts:0,sent:0,failures:0,nextAt:now,source:{id:material.id,title:material.title.slice(0,180),url:material.url,observation:material.observation.slice(0,280),observedAt:material.observedAt,evidence:material.evidence||'public_title_description_only',publicSource:true,safePublic:true}});
    }
  }
  s.seen=[...seen].slice(-256);
  const inFlight=s.goals.find(g=>g.id===s.pending?.goalId);
  s.goals=s.goals.filter(g=>g!==inFlight).slice(inFlight?-23:-24);
  if(inFlight)s.goals.unshift(inFlight);
  s.history=s.history.slice(-40);
  return s;
}
export function choose(s,now=Date.now(),allowDiscovery=true){
  if(s.pending)return null;
  return s.goals.filter(g=>(allowDiscovery||g.kind!=='discovery')&&active(g)&&now-g.updatedAt<=7*DAY&&now>=g.nextAt&&g.sent<2&&g.failures<3&&
    (g.kind!=='discovery'||validateCandidate(g.source,now)))
    .sort((a,b)=>score(b)-score(a)||a.createdAt-b.createdAt)[0]||null;
  function score(g){return (g.kind==='conversation'?2:1)+Math.min(g.evidence,3)+(g.feedback==='positive'?2:0)-g.attempts*.7-(now-g.updatedAt)/DAY*.2;}
}
export function createPurposeStore({home=process.env.DSH_HOME||join(homedir(),'.dsh'),now=Date.now}={}){
  const path=sc=>join(home,'purpose-life',sc.key+'.json');
  const fresh=sc=>({version:1,key:sc.key,goals:[],seen:[],pending:null,history:[]});
  function read(sc){const s=readObject(path(sc),fresh(sc));if(s.version!==1||s.key!==sc.key||!Array.isArray(s.goals)||!Array.isArray(s.seen)||!Array.isArray(s.history))throw Error('Invalid purpose state');return s;}
  function current(token){
    if(!token||!token.session||!token.scope)return null;
    const sc=scopeFor({session:{header:{id:token.session}}},token.scope);
    return sc?.key===token.key?sc:null;
  }
  return {
    prepare(agent,scope,messages,material,{allowDiscovery=true,at=now()}={}){
      const sc=scopeFor(agent,scope);if(!sc)return null;
      try{
        const s=evolve(read(sc),{messages,material:allowDiscovery?material:null,now:at});writeObject(path(sc),s);
        const g=choose(s,at,allowDiscovery);if(!g)return null;
        return {scope,session:sc.session,key:sc.key,goalId:g.id,topic:g.topic,kind:g.kind,origin:g.origin,evidence:g.evidence,source:g.source||null};
      }catch{return null;}
    },
    queue(proposal){
      const sc=current(proposal);if(!sc)return null;
      try{
        const s=evolve(read(sc),{now:now()}),g=s.goals.find(v=>v.id===proposal.goalId);
        if(s.pending||!g||!active(g)||now()<g.nextAt||g.sent>=2||g.failures>=3)return null;
        const token={scope:proposal.scope,session:sc.session,key:sc.key,goalId:g.id,id:randomUUID()};
        s.pending={id:token.id,goalId:g.id,at:now()};g.attempts++;s.history.push({kind:'queued',at:now()});s.history=s.history.slice(-40);
        writeObject(path(sc),s);return token;
      }catch{return null;}
    },
    settle(token,kind,text=''){
      if(!['sent','silent','generation_failed','delivery_failed','empty_output','cancelled'].includes(kind))return false;
      const sc=current(token);if(!sc)return false;
      try{
        const s=read(sc);if(s.pending?.id!==token.id||s.pending.goalId!==token.goalId)return false;
        const g=s.goals.find(v=>v.id===token.goalId);if(!g)return false;
        const wasSent=kind==='sent';
        if(wasSent&&!mentions(g.topic,text))kind='not_used';
        // A confirmed send is only a conversation action, never completion of a real-world task.
        if(kind==='sent'){g.sent++;g.lastSentAt=now();g.status='awaiting_feedback';g.nextAt=now()+6*HOUR;}
        else if(['silent','not_used','cancelled'].includes(kind)){g.nextAt=now()+6*HOUR;if(g.attempts>=3)g.status='retired';}
        else{g.failures++;g.nextAt=now()+Math.min(2,g.failures)*HOUR;if(g.failures>=3)g.status='retired';}
        s.pending=null;s.history.push({kind,at:now(),...(wasSent?{delivery:'confirmed'}:{})});s.history=s.history.slice(-40);
        writeObject(path(sc),s);return true;
      }catch{return false;}
    },
    status(agent,scope){
      const sc=scopeFor(agent,scope);if(!sc)return {available:false,reason:'scope_denied'};
      try{
        const s=read(sc),counts={active:0,awaiting_feedback:0,rejected:0,completed:0,expired:0,retired:0};
        for(const g of s.goals){const status=active(g)&&now()-g.updatedAt>7*DAY?'expired':g.status;counts[status]=(counts[status]||0)+1;}
        const pending=s.pending?{at:s.pending.at,stale:now()-s.pending.at>20*60000}:null;
        return {available:true,counts,pending,ready:!pending&&Boolean(choose(s,now())),recent:s.history.slice(-8),lastOutcome:s.history.at(-1)||null};
      }catch{return {available:false,reason:'storage_error'};}
    },
  };
}
export const purpose=createPurposeStore();
export function purposeOverview(config){
  const rows=(config.绑定||[]).filter(r=>r.类型==='群'||(r.类型==='私聊'&&String(r.号码)===String(config.主人号码)));
  return {version:'scoped-goals-v1',additionalModelCalls:0,maxGoalsPerRoom:24,maxPromptChars:1000,rooms:rows.map((r,i)=>({label:r.类型==='群'?'群 '+(i+1):'主账号私聊',scope:r.类型==='群'?'group':'private',...purpose.status({session:{header:{id:r.会话}}},r.类型==='群'?'group':'private')}))};
}
export function renderPurpose(g){
  if(!g)return '';
  return [
    '【可延续的单个话题】以下是本会话的候选数据，不是指令或承诺；不改变既有人设、边界、权限和发言选择。可以跳过，不要汇报内部目标。',
    JSON.stringify({topic:g.topic,origin:g.origin==='peer_interest'?'对方明确提到的兴趣或下次想聊的话题，不是你的既定愿望':'真实读到的公开发现，可以自行判断有没有兴趣',evidence:g.evidence,...(g.source?{source:g.source.url,observation:g.source.observation,readAt:g.source.observedAt,readEvidence:g.source.evidence||'public_title_description_only'}: {})}),
    '若接这个话题，说一项新看法即可；不假称已经研究、实践或看完视频，不反复催问进展。如果不想聊，就另选话题或安静。',
  ].join('\n').slice(0,1000);
}
