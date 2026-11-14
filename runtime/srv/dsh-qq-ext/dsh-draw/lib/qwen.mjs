import {compileImageSpec,appearanceReference,imagegenPolicy} from './imagegen-skill.mjs';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync,realpathSync} from 'node:fs';
import {join,basename,sep} from 'node:path';
import {qualityGuide} from './handoff.mjs';
export const engine='bailian_qwen_image',model='qwen-image-3.0-pro';
export function cloud(command,data,signal){
 return new Promise((resolve,reject)=>{
  const p=spawn('/usr/bin/python3',['/srv/dsh-qwen-image/qwen_worker.py',command],{stdio:['pipe','pipe','pipe'],windowsHide:true,signal,timeout:55000});
  let stdout='',stderr='';p.stdout.on('data',x=>{stdout+=x;if(stdout.length>1800000)p.kill()});p.stderr.on('data',x=>{if(stderr.length<1000)stderr+=x});
  p.on('error',reject);p.on('close',code=>{try{if(code!==0)throw Error('云端生图队列暂不可用，请先查询状态，勿重复提交');resolve(JSON.parse(stdout))}catch(e){reject(e)}});
  p.stdin.on('error',()=>{});p.stdin.end(JSON.stringify(data));
 });
}
export function createQwenQueue(home,{request=cloud}={}){
 return {
  async submit(args,who,signal){
   if(who.role!=='owner'||who.inherited)throw Error('仅主账号会话可提交生图');
   const {prompt}=compileImageSpec(args);const reference=appearanceReference(home);
   const dimension=x=>Math.round(Math.max(512,Math.min(Number(x)||1536,2048)));
   const width=dimension(args.width),height=dimension(args.height);
   const id=createHash('sha256').update(JSON.stringify([model,who.session,prompt,width,height,args.seed??null,new Date().toISOString().slice(0,10)])).digest('hex').slice(0,32);
   const j=await request('enqueue',{id,session:who.session,ownerQQ:who.qq,prompt,width,height,qualityGuide},signal);
   return {workflowPolicy:imagegenPolicy,reference,requestId:j.id,status:j.status,engine,model,automatic:true,generated:j.status==='completed',path:j.status==='completed'?j.path:null,next:'云端已接手：参考图生成→泡泡看实际图片→最多两次定向返工→明确满意后立即提醒私聊发送。排队不代表已经出图，completed也不代表QQ已收到；以ownerNotification为准。',ownerNotification:j.ownerNotification||null};
  },
  list(who,signal){return request('list',{session:who.session,ownerQQ:who.qq},signal)}
 };
}
export function importResult(home,payload,who){
 const j=payload.job;
 if(!j||!/^[a-f0-9]{32}$/.test(j.id||'')||j.engine!==engine||j.model!==model)throw Error('Invalid cloud image job');
 if(who.role!=='owner'||who.inherited||who.session!==j.session||String(who.qq)!==String(j.ownerQQ))throw Error('Owner binding mismatch');
 const dir=join(home,'image-handoff');mkdirSync(dir,{recursive:true,mode:0o700});const file=join(dir,j.id+'.json');
 let old=null;if(existsSync(file))old=JSON.parse(readFileSync(file,'utf8'));
 if(old&&(old.session!==j.session||String(old.ownerQQ)!==String(j.ownerQQ)))throw Error('Stored owner mismatch');
 // Never regress a delivered job or overwrite its actual QQ receipt.
 if(old?.status==='completed'){
  if(j.sha256&&old.sha256!==j.sha256)throw Error('Final checksum changed');
  return {ok:true,duplicate:true};
 }
 if(j.status==='completed'){
  if(j.reviewStatus!=='approved_by_paopao'||j.deliveryStatus!=='returned_to_paopao_as_image_attachment'||!j.review?.requestId||!j.review?.decision?.can_see||j.review?.decision?.decision!=='approve'||j.review?.decision?.satisfied!==true)throw Error('Unapproved image');
  if(j.path!=='/srv/dsh-cloud/home/drawings/qwen-'+j.id+'-final.png'||!/^[a-f0-9]{64}$/.test(j.sha256||''))throw Error('Invalid final path');
  const bytes=Buffer.from(payload.image||'','base64');
  if(bytes.length>24*1024*1024||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||createHash('sha256').update(bytes).digest('hex')!==j.sha256||j.review.candidateSha256!==j.sha256)throw Error('Image checksum mismatch');
  const images=join(home,'drawings');mkdirSync(images,{recursive:true,mode:0o700});
  const target=join(images,basename(j.path));
  if(existsSync(target)&&!realpathSync(target).startsWith(realpathSync(images)+sep))throw Error('Image escaped directory');
  const tmp=target+'.'+randomUUID()+'.tmp';writeFileSync(tmp,bytes,{mode:0o600});renameSync(tmp,target);
 }
 const clean={...j};delete clean.ownerNotification;delete clean.providerOutput;
 if(old?.ownerNotification)clean.ownerNotification=old.ownerNotification;
 const tmp=file+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(clean,null,2)+'\n',{mode:0o600});renameSync(tmp,file);
 return {ok:true};
}
