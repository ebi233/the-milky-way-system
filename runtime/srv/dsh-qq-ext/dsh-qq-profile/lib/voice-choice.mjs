import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';

export const VOICES=Object.freeze([
 {id:'longanlingxin_v3.1',name:'龙安灵心',engine:'qwen'},
 {id:'longanhuan_v3.1',name:'龙安欢',engine:'qwen'},
 {id:'zh_female_qingchezizi_uranus_bigtts',name:'清澈梓梓 2.0'},
 {id:'zh_female_qingxinnvsheng_uranus_bigtts',name:'清新女声 2.0'},
 {id:'zh_female_wenjingmaomao_uranus_bigtts',name:'文静毛毛 2.0'},
 {id:'zh_female_xiaohe_uranus_bigtts',name:'小何 2.0'},
]);
export function parseSpeed(value){
 if(value===undefined||value===null||value==='')return undefined;
 if(!/^[+-]?\d{1,2}%?$/.test(String(value)))throw Error('语速应为 -30% 到 +30%');
 const n=Number(String(value).replace('%',''));
 if(!Number.isInteger(n)||n < -30||n > 30)throw Error('语速应为 -30% 到 +30%');
 return n;
}
const findVoice=value=>VOICES.find(v=>v.id===value||v.name===value);
const readJSON=path=>{try{return JSON.parse(readFileSync(path,'utf8'))}catch(e){if(e.code==='ENOENT')return {};throw Error('音色配置读取失败，请先检查配置');}};
export function createVoiceChoice(home){
 const file=join(home,'voice-preferences.json');
 function get(){
  const p=readJSON(file),cfg=readJSON(join(home,'tts-config.json'));
  if(p.voice&&!findVoice(p.voice))throw Error('已保存音色不在已验证目录');
  return {voice:p.voice||cfg.speaker||'zh_female_qingchezizi_uranus_bigtts',speed:parseSpeed(p.speed)??0,selectedBy:p.selectedBy||'existing-config'};
 }
 function select(args,who){
  if(who?.role!=='owner'||who.inherited)throw Error('仅在已核实的主人私聊会话中选择全局音色');
  const v=findVoice(String(args.voice||''));if(!v)throw Error('请从已验证音色目录中选择');
  const p={voice:v.id,speed:parseSpeed(args.speed)??get().speed,selectedBy:'paopao',updatedAt:new Date().toISOString()};
  const temp=file+`.${process.pid}.tmp`;
  writeFileSync(temp,JSON.stringify(p,null,2)+'\n',{mode:0o600});renameSync(temp,file);
  return {...p,name:v.name};
 }
 function plan(args={}){
  const p=get(),value=String(args.voice||'').trim(),speed=parseSpeed(args.speed)??p.speed;
  const explicit=Boolean(value);
  if(explicit&&/^zh-CN-[A-Za-z]+Neural$/.test(value))return {engine:'edge-tts',voice:value,speed,explicit};
  const v=explicit?findVoice(value):null;
  if(explicit&&!v)throw Error('未知音色；请先用 qq_voice_settings 查看已验证目录');
  const selected=v||findVoice(p.voice);
  return {engine:selected?.engine||'volcano',voice:selected?.id||p.voice,speed,explicit};
 }
 return {get,select,plan,list:()=>VOICES.map(v=>({...v}))};
}
