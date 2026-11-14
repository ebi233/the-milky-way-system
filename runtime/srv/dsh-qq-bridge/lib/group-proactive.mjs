import {join} from 'node:path';
import {homedir} from 'node:os';
import {readObject,writeObject,singleFlight} from './runtime-state.mjs';
import {activityContext} from './proactive-context.mjs';
import {purpose} from './purpose-engine.mjs';
import {activityPlan} from './activity-plan.mjs';
import {assertTrustedGroup} from '../../dsh-qq-ext/dsh-long-memory/lib/group-privacy.mjs';
import {groupCandidate,numericMood,shareChance} from '../../dsh-qq-ext/dsh-public-social/social-policy.mjs';
const home=process.env.DSH_HOME || join(homedir(),'.dsh');
export function createGroupProactive({readConfig,start,isBusy=()=>false,getAgent=()=>null,canStart=async()=>true,now=Date.now,random=Math.random}){
  const file=join(home,'group-proactive-state.json');
  const settingsFile=join(home,'group-proactive-config.json');
  const settings=()=>{
    const c={unansweredWaitMinutes:120,maxIdleHours:24,...readObject(settingsFile,{enabled:true,minMinutes:120,maxMinutes:360,dailyLimit:2,startHour:9,endHour:23})};
    if(typeof c.enabled!=='boolean' || !Number.isFinite(c.minMinutes) || !Number.isFinite(c.maxMinutes) || c.minMinutes<10 || c.maxMinutes<c.minMinutes || c.maxMinutes>1440 || !Number.isInteger(c.dailyLimit) || c.dailyLimit<0 || c.dailyLimit>8 || !(c.startHour>=0 && c.endHour<=24 && c.startHour<c.endHour))throw new Error('Invalid group proactive configuration');
    if(c.phased===true && !(Number.isFinite(c.nightMinMinutes)&&Number.isFinite(c.nightMaxMinutes)&&c.nightMinMinutes>=10&&c.nightMaxMinutes>=c.nightMinMinutes&&c.nightMaxMinutes<=1440))throw new Error('Invalid night interval');
    if(!Number.isFinite(c.unansweredWaitMinutes)||c.unansweredWaitMinutes<0||c.unansweredWaitMinutes>1440||!Number.isFinite(c.maxIdleHours)||c.maxIdleHours<0||c.maxIdleHours>8760)throw new Error('Invalid autonomy policy');
    if(c.disabledGroups!==undefined && (!Array.isArray(c.disabledGroups)||c.disabledGroups.some(g=>typeof g!=='string'||!/^\d+$/.test(g))))throw new Error('Invalid disabled groups');
    return c;
  };
  const allowsUnsolicited=row=>!(settings().disabledGroups||[]).includes(String(row?.号码));
  const allowsDelivery=(row,source)=>source==='qq'||allowsUnsolicited(row);
  const state=()=>{const v=readObject(file,{version:1,groups:{}});if(v.version!==1 || !v.groups || Array.isArray(v.groups))throw new Error('Invalid group proactive state');return v;};
  const daytime=stamp=>{
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(stamp)).map(p=>[p.type,p.value]));
    return {day:parts.year+'-'+parts.month+'-'+parts.day,hour:Number(parts.hour)};
  };
  let lastError=null;
  const window=(c,stamp=now())=>{const hour=daytime(stamp).hour,night=c.phased===true&&hour>=1&&hour<8;return {period:night?'night':'day',minMinutes:night?c.nightMinMinutes:c.minMinutes,maxMinutes:night?c.nightMaxMinutes:c.maxMinutes};};
  const next=(c,stamp)=>{const w=window(c,stamp);return stamp+(w.minMinutes+random()*(w.maxMinutes-w.minMinutes))*60000;};
  const signature=c=>JSON.stringify([c.minMinutes,c.maxMinutes,c.phased,c.nightMinMinutes,c.nightMaxMinutes,c.startHour,c.endHour,c.dailyLimit,c.unansweredWaitMinutes,c.maxIdleHours]);
  // A freshly sealed room starts without old-room topics, reply IDs or activity.
  // Preserve only the per-group daily quota, so replacing a room cannot reset it.
  const freshRoom=(row,previous={})=>({session:row.会话,day:previous.day,count:Math.max(0,Number(previous.count)||0)});
  function observe(row,time=now(),evidence={}){
    if(row?.类型!=='群')return;
    assertTrustedGroup(row,readConfig());
    const c=settings(),s=state(),group=String(row.号码),stored=s.groups[group]||{};
    const previous=stored.session && stored.session!==row.会话 ? freshRoom(row,stored) : stored;
    const at=Math.min(now(),Number(time)||now());
    const addressed=evidence.directed===true || (evidence.replyIds||[]).some(id=>(previous.sentIds||[]).includes(String(id)));
    const engaged=addressed && at>=(previous.lastAttemptAt||0);
    s.groups[group]={...previous,session:row.会话,lastActivityAt:at,
      awaitingActivity:previous.awaitingActivity===true && !engaged,
      lastEngagedAt:engaged?at:previous.lastEngagedAt,
      intervalSignature:signature(c),nextAt:next(c,at)};
    writeObject(file,s);
  }
  function acknowledge(row,inputAt){
    assertTrustedGroup(row,readConfig());
    const s=state(),g=s.groups[String(row.号码)];
    if(!g || g.session!==row.会话 || !g.awaitingActivity || inputAt<=g.lastAttemptAt || inputAt!==g.lastActivityAt)return false;
    g.awaitingActivity=false;g.lastEngagedAt=inputAt;writeObject(file,s);return true;
  }
  function sent(row,ids){
    assertTrustedGroup(row,readConfig());
    const s=state(),key=String(row.号码),stored=s.groups[key]||{};
    const g=stored.session===row.会话 ? stored : freshRoom(row,stored);
    g.sentIds=[...new Set([...(g.sentIds||[]),...ids.filter(Boolean).map(String)])].slice(-100);
    g.lastSentAt=now();g.nextAt=next(settings(),now());g.lastOutcome={kind:'sent',at:now()};s.groups[key]=g;writeObject(file,s);
  }
  function outcome(row,kind){
    if(!['gate_missing','model_declined','generation_failed','delivery_failed','queued'].includes(kind))throw Error('Invalid outcome');
    assertTrustedGroup(row,readConfig());const s=state(),g=s.groups[String(row.号码)];
    if(!g||g.session!==row.会话)return;
    if(kind!=='queued'&&g.lastOutcome?.kind==='queued'){
      // A declined/failed attempt sent nothing; nobody has a message to answer.
      g.awaitingActivity=false;g.nextAt=next(settings(),now());
      if(g.day===daytime(now()).day)g.count=Math.max(0,(Number(g.count)||0)-1);
    }
    g.lastOutcome={kind,at:now()};writeObject(file,s);
  }
  const run=singleFlight(async()=>{
    const conf=readConfig(),c=settings();
    if(!c.enabled || !conf.总开关 || conf.试运行)return;
    const stamp=now(),local=daytime(stamp);
    if(local.hour<c.startHour || local.hour>=c.endHour)return;
    const s=state();
    for(const row of conf.绑定||[]){
      if(row.类型!=='群'||!allowsUnsolicited(row))continue;
      const key=String(row.号码),g=s.groups[key];
      if(g?.session && g.session!==row.会话){
        assertTrustedGroup(row,conf);
        s.groups[key]=freshRoom(row,g);writeObject(file,s);
        continue; // Wait for a new message in this room before scheduling.
      }
      if(g?.session===row.会话 && g.intervalSignature!==signature(c)){
        g.intervalSignature=signature(c);g.nextAt=next(c,stamp);
        if(g.awaitingActivity&&['model_declined','gate_missing','generation_failed','delivery_failed'].includes(g.lastOutcome?.kind))g.awaitingActivity=false;
        writeObject(file,s);
      }
      const resumeUnanswered=g?.awaitingActivity===true && stamp-Math.max(Number(g.lastSentAt)||0,Number(g.lastAttemptAt)||0)>=c.unansweredWaitMinutes*60000;
      if(!g || g.session!==row.会话 || !g.lastActivityAt || (g.awaitingActivity&&!resumeUnanswered) || !Number.isFinite(g.nextAt) || stamp<g.nextAt || (c.maxIdleHours>0&&stamp-g.lastActivityAt>c.maxIdleHours*3600000&&!resumeUnanswered) || isBusy(row.会话))continue;
      assertTrustedGroup(row,conf);
      const count=g.day===local.day?Number(g.count)||0:0;if(c.dailyLimit>0&&count>=c.dailyLimit)continue;
      if(!await canStart()){lastError='channel_unavailable';return;}
      if(!allowsUnsolicited(row))continue; // Recheck after asynchronous channel readiness.
      let material=groupCandidate(home,g.offeredPublicIds||[],stamp);
      // Mood influences whether to offer a public discovery; it cannot disclose
      // private mood reasons or bypass the group's own silence/privacy gates.
      const allowDiscovery=random()<=shareChance(numericMood(home,stamp),stamp);
      if(!allowDiscovery){
        material=null; // Declining one discovery must not veto other conversation.
      }
      // Persist before queuing: a restart must not repeat an unacknowledged attempt.
      s.groups[key]={...g,offeredPublicIds:material?[...(g.offeredPublicIds||[]),material.id].slice(-32):(g.offeredPublicIds||[]),day:local.day,count:count+1,lastAttemptAt:stamp,nextAt:next(c,stamp),awaitingActivity:true,lastOutcome:{kind:'queued',at:stamp}};writeObject(file,s);
      const plan=activityPlan({agent:getAgent(row.会话),scope:'group',now:stamp,material,checks:count,allowDiscovery});
      const context=activityContext({scope:'group',now:stamp,lastInputAt:g.lastActivityAt,lastSentAt:g.lastSentAt,plan});
      const purposeToken=purpose.queue(plan.goal);
      let result;
      try{result=await start(row,context+'\n\n（这是本群的一次自主活动机会，不是任何群成员发来的消息。可用本群公开聊过的内容、上面的公开素材、普通兴趣或一个轻松问题；不要带入私聊，不编造刚发生的经历。有具体发现可以自然分享自己的看法，不必把每次开口都变成提问。先判断现在是否值得开口，可以选择不说；若开口只说一两句，不提定时器或冷场判断，不点名催人回复。）',purposeToken);}
      catch{purpose.settle(purposeToken,'generation_failed');outcome(row,'generation_failed');lastError='queue_failed';return;}
      if(!result?.ok){purpose.settle(purposeToken,'generation_failed');outcome(row,'generation_failed');lastError='queue_failed';}else lastError=null;
      break; // At most one group per tick.
    }
  });
  return {allowsUnsolicited,allowsDelivery,observe,acknowledge,sent,outcome,tick:async()=>{try{await run();}catch{lastError='state_or_guard_error';}},status:()=>{
    try{const c=settings(),s=state(),conf=readConfig(),stamp=now(),local=daytime(stamp);
      const details=(conf.绑定||[]).filter(r=>r.类型==='群').map(r=>{
        const g=s.groups[String(r.号码)]||{},count=g.day===local.day?Number(g.count)||0:0;
        let reason='ready';
        try{assertTrustedGroup(r,conf)}catch{reason='privacy_guard'}
        if(reason==='ready'){
          if(!c.enabled||!conf.总开关)reason='disabled';else if(!allowsUnsolicited(r))reason='group_disabled';else if(conf.试运行)reason='dry_run';
          else if(g.session && g.session!==r.会话)reason='session_changed';
          else if(!g.lastActivityAt)reason='waiting_first_message';
          else if(g.awaitingActivity&&stamp-Math.max(Number(g.lastSentAt)||0,Number(g.lastAttemptAt)||0)<c.unansweredWaitMinutes*60000)reason='waiting_for_engagement';
          else if(local.hour<c.startHour||local.hour>=c.endHour)reason='quiet_hours';
          else if(c.dailyLimit>0&&count>=c.dailyLimit)reason='daily_limit';
          else if(c.maxIdleHours>0&&stamp-g.lastActivityAt>c.maxIdleHours*3600000&&!g.awaitingActivity)reason='inactive_over_24h';
          else if(isBusy(r.会话))reason='conversation_busy';
          else if(stamp<g.nextAt)reason='random_wait';
        }
        const labels={group_disabled:'本群仅回应新消息，不主动发言',ready:'等待下一次检查',privacy_guard:'群隔离检查未通过',disabled:'开关已关闭',dry_run:'试运行',session_changed:'群会话已更换，正在重新初始化搭话计划',waiting_first_message:'等待群里第一条新消息',waiting_for_engagement:`无人接话，等待 ${c.unansweredWaitMinutes} 分钟后可重新判断`,quiet_hours:'安静时段',daily_limit:'今天尝试次数已用完',inactive_over_24h:`群内超过 ${c.maxIdleHours} 小时没有新交流`,conversation_busy:'正在处理群消息',random_wait:'随机等待中'};
        const sameRoom=g.session===r.会话;
        return {groupTail:String(r.号码).slice(-4),reason,explanation:labels[reason],nextAt:reason==='group_disabled'?null:sameRoom?(g.awaitingActivity?Math.max(g.nextAt||0,Math.max(Number(g.lastSentAt)||0,Number(g.lastAttemptAt)||0)+c.unansweredWaitMinutes*60000):g.nextAt||null):null,attemptsToday:count,lastOutcome:sameRoom?g.lastOutcome||null:null};
      });
      return {enabled:c.enabled,minMinutes:c.minMinutes,maxMinutes:c.maxMinutes,phased:c.phased===true,nightMinMinutes:c.nightMinMinutes,nightMaxMinutes:c.nightMaxMinutes,currentWindow:window(c,stamp),dailyLimit:c.dailyLimit,dailyLimitLabel:c.dailyLimit===0?'不限':String(c.dailyLimit),unansweredWaitMinutes:c.unansweredWaitMinutes,maxIdleHours:c.maxIdleHours,activeHours:[c.startHour,c.endHour],timezone:'Asia/Shanghai',trackedGroups:Object.keys(s.groups).length,waitingForReply:(conf.绑定||[]).filter(r=>r.类型==='群' && s.groups[String(r.号码)]?.session===r.会话 && s.groups[String(r.号码)]?.awaitingActivity&&c.unansweredWaitMinutes>0&&stamp-Math.max(Number(s.groups[String(r.号码)].lastSentAt)||0,Number(s.groups[String(r.号码)].lastAttemptAt)||0)<c.unansweredWaitMinutes*60000).length,lastError,details};}
    catch{return {enabled:false,lastError:'invalid_state'};}
  }};
}
