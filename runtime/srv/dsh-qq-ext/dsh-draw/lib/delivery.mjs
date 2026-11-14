import {readFileSync,writeFileSync,renameSync,realpathSync} from 'node:fs';
import {join,basename,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export function readApprovedJob(home,id){
 if(!/^[a-f0-9]{32}$/.test(id||''))throw Error('Invalid job id');
 const file=join(home,'image-handoff',id+'.json'),job=JSON.parse(readFileSync(file,'utf8'));
 if(job.id!==id||job.status!=='completed'||job.reviewStatus!=='approved_by_paopao'||job.deliveryStatus!=='returned_to_paopao_as_image_attachment')throw Error('Image is not reviewed and returned');
 if(!/^\/srv\/dsh-cloud\/home\/drawings\/[\w.-]+\.(png|jpe?g|webp)$/i.test(job.path||''))throw Error('Unexpected final path');
 const root=realpathSync(join(home,'drawings')),image=realpathSync(join(root,basename(job.path)));
 if(!image.startsWith(root+sep))throw Error('Image escaped drawing directory');
 if(createHash('sha256').update(readFileSync(image)).digest('hex')!==job.sha256)throw Error('Final image checksum mismatch');
 return {file,job};
}
export function updateNotification(file,sha,patch){
 const job=JSON.parse(readFileSync(file,'utf8'));
 if(job.sha256!==sha)throw Error('Final image changed during delivery');
 job.ownerNotification={...job.ownerNotification,...patch,updatedAt:new Date().toISOString()};
 const tmp=file+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(job,null,2)+'\n',{mode:0o600});renameSync(tmp,file);
 return job.ownerNotification;
}
export function createCompletionNotifier({home,resolve,identify,register,flush}){
 const inFlight=new Set();
 return async function notify(id){
  if(inFlight.has(id))return {ok:true,duplicate:true,phase:'dispatching'};
  inFlight.add(id);
  try{
   const {file,job}=readApprovedJob(home,id);
   if(job.ownerNotification)return {ok:true,duplicate:true,...job.ownerNotification};
   const agent=await resolve(job.session),who=identify(agent);
   if(who.role!=='owner'||who.inherited||who.session!==job.session||String(who.qq)!==String(job.ownerQQ))throw Error('Owner binding changed');
   const requestId=randomUUID();
   const message={id:requestId,role:'user',source:{kind:'image-handoff-ready',jobId:id},content:[{type:'text',text:
    '【图片交付事件｜系统任务，不是用户新消息】\n成图已由你审定并回传；本次主账号私聊投递已获授权，目前尚无匹配图片的QQ回执。请在本轮自然回应并附图：\n![成图]('+job.path+')\n任务范围仅此张图片、仅主账号私聊。无需再次生图或额外发送工具；不重复投递，不把本通知当作聊天正文或人设。若不愿发送，说明即可；未取得回执不能声称已送达。'}]};
   const save=patch=>updateNotification(file,job.sha256,patch);
   save({phase:'dispatching',requestId,sha256:job.sha256,trigger:'completion_callback',requestedAt:new Date().toISOString()});
   const revoke=register(job.session,message,result=>{
    try{
     if(result.phase==='notified'){save({phase:'notified'});return;}
     const ids=(result.imageReceipts||[]).filter(r=>r.sha256===job.sha256).map(r=>r.messageId);
     save({...result,phase:result.sent&&ids.length?'sent':result.phase||'needs_check',imageMessageIds:ids});
    }catch{}
   });
   try{await agent.followup(message);await flush(agent);}
   catch{revoke();save({phase:'needs_check',reason:'followup_or_persistence_failed'});throw Error('Notification admission uncertain; inspect before retry');}
   return {ok:true,...JSON.parse(readFileSync(file,'utf8')).ownerNotification};
  }finally{inFlight.delete(id);}
 };
}
