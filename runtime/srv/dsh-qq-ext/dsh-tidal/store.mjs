import fs from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {defaults,parameters,policy} from './core.mjs';
export const hash=s=>createHash('sha256').update(s).digest('hex');
export function readBounded(path,max=1048576){
 const st=fs.lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.size>max)throw Error('State file bound');
 const fd=fs.openSync(path,'r');try{
  const b=Buffer.alloc(st.size+1);let n=0,count;
  while(n<b.length&&(count=fs.readSync(fd,b,n,b.length-n,null)))n+=count;
  if(n!==st.size)throw Error('State file changed');return JSON.parse(b.subarray(0,n).toString('utf8'));
 }finally{fs.closeSync(fd)}
}
export function controlStore(home){
 const dir=join(home,'tidal-state'),file=join(dir,'policy.json');
 function read(){
  const c=readBounded(file,65536);
  if(c.version!==1||typeof c.enabled!=='boolean'||typeof c.allowSelfTune!=='boolean'||!Number.isInteger(c.revision)||c.revision<1||!Array.isArray(c.history)||c.history.length>32)throw Error('Invalid tidal policy');
  return {...c,params:parameters(c.params)};
 }
 function edit(args){
  const before=read();if(!before.enabled||!before.allowSelfTune)throw Error('Tidal self tuning disabled');
  if(args.expected_revision!==before.revision)throw Error('状态参数已变化，请重新 read');
  if(typeof args.reason!=='string'||!args.reason.trim()||args.reason.length>240)throw Error('需要简短修改原因');
  const changes=args.changes;if(!changes||!Object.keys(changes).length)throw Error('No parameter changes');
  const params=parameters({...before.params,...changes});if(JSON.stringify(params)===JSON.stringify(parameters(before.params)))return {unchanged:true,revision:before.revision};
  const entry={revision:before.revision,params:parameters(before.params),at:Date.now(),reason:args.reason.trim(),actor:'paopao'};
  if(before.history.length>=32)throw Error('参数历史已满，停止新增，不自动删除旧版本');
  const c={...before,params,revision:before.revision+1,history:[...before.history,entry]};
  const lock=join(dir,'write.lock');let fd;
  try{fd=fs.openSync(lock,'wx',0o600)}catch{throw Error('参数正在修改，请稍后重新读取')}
  try{
   if(JSON.stringify(read())!==JSON.stringify(before))throw Error('Concurrent parameter edit');
   const temp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(c,null,2)+'\n',{mode:0o600});fs.renameSync(temp,file);
  }finally{fs.closeSync(fd);fs.unlinkSync(lock)}
  return {revision:c.revision,params,policy,effective:'next_request',restartRequired:false};
 }
 return {read,edit,rollback(args){const c=read(),old=c.history.find(x=>x.revision===args.version);if(!old)throw Error('历史参数版本不存在');return edit({...args,changes:old.params});}};
}
export function readMood(home,who,{strict=false}={}){
 if(who.role!=='owner'||who.inherited||who.conflict)return {};
 const c=readBounded(join(home,'feiyu-mood/config.json'),262144);
 if((c.模式||c.mode||'session')!=='session'){if(strict)throw Error('State scope mode');return {}}
 const norm=s=>String(s||'').replace(/^session-/,'');
 const slots=(c.slots||[]).filter(s=>Array.isArray(s.sessions)&&s.sessions.some(id=>norm(id)===norm(who.session)));
 if(slots.length!==1||slots[0].sessions.length!==1){if(strict)throw Error('State scope binding');return {}}
 const state=readBounded(join(home,'feiyu-mood/tidal-current.json'),262144);
 if(state.version!==1)throw Error('Invalid mood projection');
 return state.moods?.[slots[0].id]||{};
}
// Published after canonical mood persistence, or once on initial load. No timeline/quotes are copied.
export function publishMoodSnapshot(home,moods){
 if(!moods||typeof moods!=='object'||Object.keys(moods).length>16)throw Error('Mood slot bound');
 const current={version:1,moods:{}};
 for(const [id,raw] of Object.entries(moods)){
  if(!/^[\w-]{1,160}$/.test(id))throw Error('Invalid mood slot');
  const row={affect:{},activity:{}};
  for(const category of ['affect','activity']){
   const entries=Object.entries(raw?.[category]||{});if(entries.length>32)throw Error('Mood axis bound');
   for(const [key,v] of entries){
    if(!/^[a-zA-Z]{1,32}$/.test(key)||!v||typeof v!=='object')continue;
    row[category][key]={value:v.value,confidence:v.confidence,at:v.at,scope:String(v.scope||'').slice(0,160),evidenceHash:String(v.evidenceHash||'').slice(0,64),eventId:String(v.eventId||'').slice(0,64)};
   }
  }
  current.moods[id]=row;
 }
 const blob=JSON.stringify(current);if(Buffer.byteLength(blob)>262144)throw Error('Mood projection bound');
 const file=join(home,'feiyu-mood/tidal-current.json'),temp=file+'.'+randomUUID()+'.tmp';
 fs.writeFileSync(temp,blob,{mode:0o600});fs.renameSync(temp,file);
 return {bytes:Buffer.byteLength(blob),slots:Object.keys(current.moods).length};
}
export function enabled(home){try{return controlStore(home).read().enabled}catch{return false}}
