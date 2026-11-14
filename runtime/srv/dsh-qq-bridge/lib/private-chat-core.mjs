import fs from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
export const portalPolicy='paopao-private-chat-v1';
export const digest=value=>createHash('sha256').update(value).digest('hex');
export function equalSecret(a,b) {
  if(typeof a!=='string'||typeof b!=='string'||!b||a.length>256)return false;
  return timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
}
export function ownerBinding(config) {
  const owner=String(config.主人号码||'');
  const rows=(config.绑定||[]).filter(r=>r.类型==='私聊'&&String(r.号码)===owner);
  if(!/^\d+$/.test(owner)||rows.length!==1||!/^session-[a-zA-Z0-9-]+$/.test(rows[0].会话))throw Error('OWNER_BINDING_UNAVAILABLE');
  if(config.绑定.some(r=>r.会话===rows[0].会话&&(r.类型!=='私聊'||String(r.号码)!==owner)))throw Error('OWNER_BINDING_CONFLICT');
  return {owner,session:rows[0].会话};
}
export function validateInput(input,now=Date.now()) {
  if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['id','at','text','images'].includes(k)))throw Error('INVALID_INPUT');
  if(!/^[a-f0-9-]{36}$/.test(input.id||'')||!Number.isSafeInteger(input.at)||input.at>now+30000||now-input.at>600000)throw Error('EXPIRED_INPUT');
  if(typeof input.text!=='string'||input.text.length>12000)throw Error('TEXT_BOUND');
  const images=input.images||[];
  if(!Array.isArray(images)||images.length>2)throw Error('IMAGE_BOUND');
  let total=0;
  for(const x of images) {
    if(!x||Object.keys(x).some(k=>!['data','mediaType'].includes(k))||typeof x.data!=='string'||!['image/png','image/jpeg','image/webp','image/gif'].includes(x.mediaType)||x.data.length>7*1024*1024||x.data.length%4||/[^A-Za-z0-9+/=]/.test(x.data)||/=/.test(x.data.slice(0,-2)))throw Error('INVALID_IMAGE');
    const b=Buffer.from(x.data,'base64');total+=b.length;
    const type=b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':b[0]===255&&b[1]===216&&b[2]===255?'image/jpeg':b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP'?'image/webp':/^GIF8[79]a$/.test(b.subarray(0,6).toString())?'image/gif':null;
    if(type!==x.mediaType||b.length>5*1024*1024)throw Error('INVALID_IMAGE');
  }
  if(total>8*1024*1024||(!input.text.trim()&&!images.length))throw Error('EMPTY_OR_OVERSIZED_INPUT');
  return {...input,images};
}
export function createReceipts(dir) {
  const file=join(dir,'receipts.json');fs.mkdirSync(dir,{recursive:true,mode:0o700});
  let rows=[];
  if(fs.existsSync(file)){if(fs.statSync(file).size>262144)throw Error('RECEIPT_BOUND');rows=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(rows)||rows.length>512)throw Error('RECEIPT_INVALID');}
  const save=()=>{const tmp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(rows),{mode:0o600});fs.renameSync(tmp,file);};
  return {
    get(id){return rows.find(r=>r.id===id);},
    claim(input,session,now=Date.now()) {
      const hash=digest(JSON.stringify([input.text,input.images]));const old=rows.find(r=>r.id===input.id);
      if(old){if(old.hash!==hash||old.session!==session)throw Error('ID_CONFLICT');return {fresh:false,receipt:old};}
      rows=rows.filter(r=>now-r.at<86400000||r.phase==='accepted');
      if(rows.length>=512)throw Error('RECEIPT_CAPACITY');
      const row={id:input.id,at:input.at,hash,session,phase:'accepted',messageId:'private-web-'+input.id};rows.push(row);save();return {fresh:true,receipt:row};
    },
    settle(id,phase){const row=rows.find(r=>r.id===id);if(row){row.phase=phase;row.updatedAt=Date.now();save();}return row;},
    uncertain(){let dirty=false;for(const r of rows)if(r.phase==='accepted'){r.phase='needs_check';dirty=true;}if(dirty)save();},
  };
}
export function webTurn(events, turn) {
  const start=events.findLastIndex(e=>e.type==='turn/start'&&e.data?.turn===turn);
  if(start<0)return [];
  return events.slice(start).filter(e=>e.type==='user/message').map(e=>e.data?.message||e.data).filter(m=>m?.source?.kind==='user'&&m.source.channel==='private-web'&&m.id==='private-web-'+m.source.requestId);
}
export function isBusy(agent) {
  if(agent.status==='running')return true;
  const events=agent.session.snapshotEvents().slice(-256);
  const start=events.findLastIndex(e=>e.type==='turn/start');
  return start>=0&&!events.slice(start).some(e=>e.type==='turn/end');
}
