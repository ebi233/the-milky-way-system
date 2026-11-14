// 星河：one clock and one set of parameters for both observation updates and reads.
// Pure functions: no network, persistence, hidden wall clock or private text.
export const systemName='星河系统';
export const kernelVersion='xinghe-state-v1';
export const defaults=Object.freeze({emotionHalfMinutes:90,activityHalfHours:4,curiosityBias:1,socialBias:1,restBias:1,memoryHalfDays:14,associationMinOverlap:2,initiativeFeedbackWeight:.5,expressionRepeatThreshold:4});
const ranges={emotionHalfMinutes:[30,240],activityHalfHours:[1,12],curiosityBias:[.5,1.5],socialBias:[.5,1.5],restBias:[.5,1.5],memoryHalfDays:[2,60],associationMinOverlap:[2,5],initiativeFeedbackWeight:[0,1],expressionRepeatThreshold:[4,10]};
export const axes=Object.freeze({relaxation:['轻松',50],stress:['紧张',20],energy:['精力',50],curiosity:['好奇',50],sociability:['想聊天',50],closeness:['想亲近',0],desire:['亲密欲望',0]});
export const emotions=Object.freeze({happy:'开心',joy:'喜悦',anticipation:'期待',surprise:'惊讶',sweet:'甜蜜',moved:'感动',longing:'思念',shy:'害羞',sad:'难过',disappointed:'失落',lonely:'孤独',worry:'担忧',fear:'害怕',angry:'生气',frustrated:'挫败',jealous:'吃醋'});
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export function parameters(raw={}){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!Object.hasOwn(ranges,k)))throw Error('Unknown tidal parameter');
 const p={...defaults,...raw};
 for(const [k,[lo,hi]] of Object.entries(ranges))if(!Number.isFinite(p[k])||p[k]<lo||p[k]>hi)throw Error('Invalid tidal parameter '+k);
 return p;
}
function reason(v,session,now){
 if(!v||!Number.isFinite(v.value)||v.value<0||v.value>100||!Number.isFinite(v.confidence)||v.confidence<0||v.confidence>100||!Number.isFinite(v.at)||v.at<=0)return 'invalid';
 if(!session||v.scope!==session)return 'foreign_scope';
 if(v.at>now)return 'future';
 if(now-v.at>=86400000)return 'expired';
 if(v.confidence<60)return 'low_confidence';
 return null;
}
export function projectAxes(raw={}, {now,session,params=defaults,allowed=true}={}){
 if(!Number.isFinite(now))throw Error('Invalid time');
 const p=parameters(params),result={affect:{},activity:{},latent:{affect:{},activity:{}},diagnostics:{status:allowed?'empty':'scope_excluded',observed:0,usable:0,reasons:{}}};
 if(!allowed)return result;
 const count=k=>result.diagnostics.reasons[k]=(result.diagnostics.reasons[k]||0)+1;
 for(const category of ['affect','activity']){
  for(const [key,definition] of Object.entries(category==='affect'?emotions:axes)){
   const v=raw?.[category]?.[key];if(v===undefined)continue;
   result.diagnostics.observed++;const invalid=reason(v,session,now);if(invalid){count(invalid);continue}
   const emotion=category==='affect',base=emotion?0:definition[1],half=emotion?p.emotionHalfMinutes*60000:p.activityHalfHours*3600000;
   const weight=2**(-(now-v.at)/half),certainty=emotion?2**(-(now-v.at)/(4*3600000)):weight;
   const point={value:Math.round(base+(v.value-base)*weight),confidence:Math.round(v.confidence*certainty),at:v.at,label:emotion?definition:definition[0]};
   result.latent[category][key]=point;
   if(point.confidence<40){count('confidence_decayed');continue}
   if(emotion&&point.value<15){count('settled');continue}
   result[category][key]=point;result.diagnostics.usable++;
  }
 }
 const d=result.diagnostics;
 d.status=d.usable?(d.usable===d.observed?'observed':'partial'):!d.observed?'empty':Object.keys(d.reasons).some(k=>['invalid','foreign_scope','future'].includes(k))?'invalid':'aged_or_uncertain';
 return result;
}
// Input is an already evidence-checked assessment, not arbitrary chat text.
export function updateAxes(raw,observed,{now,session,params=defaults}={}){
 const before=projectAxes(raw,{now,session,params});
 const next={affect:{...(raw?.affect||{})},activity:{...(raw?.activity||{})}},changed={affect:[],activity:[]},receipt={version:kernelVersion,at:now,accepted:0,rejected:{}};
 const reject=k=>receipt.rejected[k]=(receipt.rejected[k]||0)+1;
 for(const [category,field] of [['affect','emotions'],['activity','activity']]){
  for(const key of Object.keys(category==='affect'?emotions:axes)){
   const v=observed?.[field]?.[key];if(v===undefined)continue;
   const invalid=reason({...v,at:now},session,now);
   if(invalid){reject(invalid);continue}
   if(typeof v.eventId!=='string'||!v.eventId||v.eventId.length>64||!/^([a-f0-9]{64})$/.test(v.evidenceHash||'')){reject('missing_evidence');continue}
   const old=raw?.[category]?.[key];
   if(old?.scope===session&&(old.eventId===v.eventId||old.evidenceHash===v.evidenceHash)){reject('duplicate');continue}
   if(old?.scope===session&&old.at>now){reject('out_of_order');continue}
   const previous=before.latent[category][key]?.value,emotion=category==='affect';
   const value=previous===undefined?v.value:previous+clamp((v.value-previous)*(emotion ? 0.5 : 0.35),emotion?-20:-12,emotion?20:12);
   next[category][key]={value:Math.round(clamp(value,0,100)),confidence:v.confidence,at:now,scope:session,eventId:v.eventId,evidenceHash:v.evidenceHash,target:'当前私聊互动',basis:'可见回复与本轮原话的逐字证据；非内心读取'};
   receipt.accepted++;changed[category].push(key);
  }
 }
 return {before,next,changed,receipt};
}
