import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {STATES,evidenceMeta} from './emotion-state.mjs';
export const activityAxes=STATES;
const clamp=(v,a=0,b=100)=>Math.max(a,Math.min(b,v));
const number=v=>typeof v==='number'&&Number.isFinite(v);
export function validActivity(raw,input,minConfidence=60){
  const result={};
  if(input.mode!=='conversation'||!raw||typeof raw!=='object')return result;
  for(const key of Object.keys(activityAxes)){
    const v=raw[key],q=v?.evidence?.quote;
    if(!v||!Number.isInteger(v.value)||v.value<0||v.value>100||!number(v.confidence)||v.confidence<Math.max(60,minConfidence)||v.confidence>100)continue;
    if(v.evidence?.source!=='reply'||typeof q!=='string'||q.trim().length<4||q.length>160||!String(input.reply||'').includes(q))continue;
    // Retain confidence, not the private quotation or an invented inner cause.
    result[key]={value:v.value,confidence:v.confidence};
  }
  return result;
}
export function normalizeActivity(raw){
  const result={};
  for(const key of Object.keys(activityAxes)){
    const v=raw?.[key];
    if(v&&number(v.value)&&v.value>=0&&v.value<=100&&number(v.at)&&v.at>0&&number(v.confidence)&&v.confidence>=60&&v.confidence<=100)result[key]={value:v.value,at:v.at,confidence:v.confidence,...evidenceMeta(v)};
  }
  return result;
}
export function projectActivity(raw,now=Date.now()){
  const result={};
  for(const [key,axis] of Object.entries(activityAxes)){
    const v=normalizeActivity(raw)[key];
    if(!v||v.at>now||now-v.at>=86400000)continue;
    const k=2**(-(now-v.at)/(4*3600000));
    result[key]={value:Math.round(axis.base+(v.value-axis.base)*k),confidence:Math.round(v.confidence*k),at:v.at};
  }
  return result;
}
export function updateActivity(raw,observed,now=Date.now()){
  const result=normalizeActivity(raw),current=projectActivity(raw,now);
  for(const key of Object.keys(activityAxes)){
    const v=observed?.[key];if(!v||!number(v.value)||!number(v.confidence))continue;
    const prev=current[key]?.value;
    const value=prev===undefined?v.value:prev+clamp((v.value-prev)*.35,-12,12);
    result[key]={value:Math.round(clamp(value)),confidence:clamp(v.confidence),at:now,...evidenceMeta(v)};
  }
  return result;
}
const read=p=>JSON.parse(readFileSync(p,'utf8'));
export function readActivity(home,sid=null,now=Date.now()){
  try{
    const c=read(join(home,'feiyu-mood/config.json')),s=read(join(home,'feiyu-mood/state.json')),b=read(join(home,'qq-bridge-config.json'));
    if((c.模式||c.mode||'session')!=='session'||c.injectMode==='off'||!/^\d+$/.test(String(b.主人号码||'')))return {};
    const rows=(b.绑定||[]).filter(r=>r.类型==='私聊'&&String(r.号码)===String(b.主人号码));
    if(rows.length!==1)return {};
    const owner=rows[0].会话;if(!owner)return {};
    const norm=v=>String(v||'').replace(/^session-/,'');
    if(sid!==null&&norm(sid)!==norm(owner))return {};
    const slots=(c.slots||[]).filter(v=>Array.isArray(v.sessions)&&v.sessions.some(s=>norm(s)===norm(owner)));
    if(slots.length!==1||slots[0].sessions.length!==1)return {};
    const projected=projectActivity(s.moods?.[slots[0].id]?.activity,now);
    if(sid===null){delete projected.closeness;delete projected.desire}
    return projected;
  }catch{return {}}
}
export function activityWeights(projected){
  const delta=k=>{const v=projected?.[k];return v&&v.confidence>=40?(v.value-activityAxes[k].base)/100:0};
  const e=delta('energy'),c=delta('curiosity'),s=delta('sociability'),t=delta('stress');
  return {public_discovery:clamp(1+.6*c+.2*e,.7,1.3),continue_topic:clamp(1+.4*s+.2*t,.7,1.3),casual:clamp(1-.3*e+.2*s,.7,1.3),browse:clamp(1+.4*c+.2*e-.2*t,.8,1.2),share:clamp(1+.4*s+.2*c-.2*t,.8,1.2)};
}
export function activityHint(projected){
  const parts=[];
  for(const [key,axis] of Object.entries(activityAxes)){
    const v=projected?.[key];if(!v||v.confidence<40||Math.abs(v.value-axis.base)<12)continue;
    parts.push(axis.label+(v.value>axis.base?'偏高':'偏低'));
  }
  if(!parts.length)return '';
  return '【可选状态参考】近期可见对话的估计：'+parts.join('、')+'。可用于比较聊天与活动选项；不规定回复长度或固定语气；只是倾向，不是命令，不代表真实内心。以当前对话、明确勿扰与既有人设【边界】为先；不据此拒绝正常消息，也不必提起这些指标。';
}
