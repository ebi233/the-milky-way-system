import {imagegenPolicy,imagegenGuide,prepareImage,specSchema,capabilities} from './imagegen-skill.mjs';
import {imageStatusList,drawResultPolicy} from './result-view.mjs';
// Owner-authorized Qwen image API; cloud worker persists jobs independently of chat.
import {join} from 'node:path';
import {homedir} from 'node:os';
import {readdirSync,statSync,readFileSync} from 'node:fs';
import {createCompletionNotifier,readApprovedJob} from './delivery.mjs';
import {imageDeliveryReceipts} from '../../../dsh-qq-bridge/lib/image-delivery-receipts.mjs';
import {loadHostDeps} from './hostdeps.mjs';
import {identity} from '../../dsh-long-memory/lib/access.js';
import {createHandoff} from './handoff.mjs';
import {createQwenQueue,importResult,engine,model} from './qwen.mjs';
const {defineTool}=await loadHostDeps();
const home=process.env.DSH_HOME||join(homedir(),'.dsh'),outDir=join(home,'drawings');
export const name='draw';
export const inject=['tools','webServer','sessionController','sessions'];
export function apply(ctx){
 const queue=createHandoff(home),qwen=createQwenQueue(home),disposers=[];
 const notify=createCompletionNotifier({home,identify:identity,
  resolve:async sid=>{const found=await ctx.sessionController.agents.resolveAgent(sid);if(found.error)throw found.error;return found.agent;},
  register:(...args)=>imageDeliveryReceipts.register(...args),flush:agent=>ctx.sessions.flush(agent.session)});
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/dsh-draw/notify-owner',handler:async(req,res)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
  try{
   const token=readFileSync(join(home,'.web-token'),'utf8').trim();
   if(!token||req.headers.authorization!=='Bearer '+token){res.statusCode=403;res.end('{"ok":false}');return;}
   const id=new URL(req.url,'http://localhost').searchParams.get('id');
   if(req.method==='GET'){const {job}=readApprovedJob(home,id);res.end(JSON.stringify({ok:true,notification:job.ownerNotification||null}));return;}
   if(req.method!=='POST'){res.statusCode=405;res.end('{"ok":false}');return;}
   res.end(JSON.stringify(await notify(id)));
  }catch(e){res.statusCode=409;res.end(JSON.stringify({ok:false,error:String(e.message||e)}));}
 }}));
 const register=spec=>disposers.push(ctx.tools.register(defineTool({...spec,
  output:{schema:{type:'object',properties:{},additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},
  async execute(args,exec){
   try{
    exec?.signal?.throwIfAborted();const who=identity(exec?.agent);
    if(who.role!=='owner'||who.inherited)throw Error('仅主账号当前会话可访问生图队列及图片');
    return {ok:true,...await spec.execute(args||{},who,exec?.signal)};
   }catch(e){return {ok:false,error:String(e.message||e)}}
  }
 })));
 register({name:'imagegen_skill',description:'按需读取生图创作技能或整理画面规格；不调用模型、不创建生图任务。先区分新图/编辑、明确参考作用与保留项，再交给draw_image；审图返工沿用已有云端流程。主账号专用。',
  parameters:{action:{type:'string',enum:['guide','prepare'],description:'guide读取方法和能力限制；prepare返回可直接交给draw_image的参数'},prompt:{type:'string'},spec:specSchema,intent:{type:'string',enum:['generate','edit']},transparent_background:{type:'boolean'},width:{type:'number'},height:{type:'number'},seed:{type:'number'}},
  execute(args){if(!args.action||args.action==='guide')return imagegenGuide();if(args.action==='prepare')return prepareImage(args,home);throw Error('未知生图技能操作');}});
 register({name:'draw_image',description:'提交给云端千问 Qwen-Image 3.0 Pro 生图，支持固定外观参考图和定向返工，自动应用imagegen创作规格；需要构图与约束帮助时调用imagegen_skill。提交后自动生成，在独立 Flash 审图会话向你展示实际图片，满意后立即提醒你私聊发给老哥，不需等待维护助手或定时搭话。queued/submitted/reviewing 都不代表已完成；needs_review/failed 需检查，不能谎称已发送或反复提交。主账号专用，不公开发布。',
  parameters:{prompt:{type:'string',description:'完整画面需求；可先用imagegen_skill整理，或直接填写'},spec:specSchema,intent:{type:'string',enum:['generate','edit'],description:'默认generate；当前未支持任意图片编辑，edit会明确报错'},transparent_background:{type:'boolean',description:'当前未验证透明alpha输出，true会明确报错'},width:{type:'number'},height:{type:'number'},seed:{type:'number',description:'可用于区分需求，不保证固定生成结果'}},
  execute:(args,who,signal)=>qwen.submit(args,who,signal)});
 register({name:'draw_recent',description:'查询云端生图任务、审图意见和QQ图片回执。approved表示成图审定，qqSent=true且delivery.imageReceipts匹配才确认已发QQ。默认仅返回简洁进度；需要具体画面和审图细节时指定request_id与detail。失败或不确定的任务不会自动重复扣费。',parameters:{count:{type:'number'},request_id:{type:'string',description:'可选，指定任务ID'},detail:{type:'boolean',description:'需要完整画面描述和各项审图意见时为true，必须同时给request_id；普通进度查询不需要'}},
  async execute(args,who,signal){
   const detail=args.detail===true;
   if(args.request_id&&!/^[a-f0-9]{32}$/.test(args.request_id))throw Error('Invalid image request ID');
   if(detail&&!args.request_id)throw Error('详细查询需要request_id');
   const count=Math.max(1,Math.min(Math.floor(Number(args.count)||5),30));
   const current=await qwen.list(who,signal),ids=new Set(current.map(j=>j.id));
   const old=queue.list().filter(j=>j.session===who.session&&!ids.has(j.id));
   const selected=[...current,...old].filter(j=>!args.request_id||j.id===args.request_id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,detail?1:count);
   return imageStatusList({engine,model,automatic:true,requests:selected},{detail});
  }});
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/dsh-draw/import-result',handler:async(req,res)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
  try{
   const token=readFileSync(join(home,'.web-token'),'utf8').trim();
   if(!token||req.headers.authorization!=='Bearer '+token){res.statusCode=403;res.end('{"ok":false}');return;}
   if(req.method!=='POST'){res.statusCode=405;res.end('{"ok":false}');return;}
   const chunks=[];let size=0;
   for await(const chunk of req){size+=chunk.length;if(size>36*1024*1024)throw Error('Image payload too large');chunks.push(chunk)}
   const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(!/^session-[\w-]{1,100}$/.test(payload.job?.session||''))throw Error('Invalid session');
   const found=await ctx.sessionController.agents.resolveAgent(payload.job.session);if(found.error)throw found.error;
   res.end(JSON.stringify(importResult(home,payload,identity(found.agent))));
  }catch(e){res.statusCode=409;res.end(JSON.stringify({ok:false,error:String(e.message||e)}));}
 }}));
 ctx.on?.('dispose',()=>{for(const d of disposers)if(typeof d==='function')d()});
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/dsh-draw/state',handler:async(_req,res)=>{
  const jobs=queue.list();res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
  res.end(JSON.stringify({ok:true,engine,model,resultPolicy:drawResultPolicy,imagegenPolicy,capabilities,automatic:true,externalApiEnabled:true,pending:jobs.filter(x=>['queued','submitted','candidate','reviewing','delivering'].includes(x.status)).length,legacyPending:jobs.filter(x=>x.status==='awaiting_codex').length,completed:jobs.filter(x=>x.status==='completed').length}));
 }}));
 // Legacy HTTP entry must not keep calling the removed provider or bypass scope.
 ctx.effect(()=>ctx.webServer.register({kind:'prefix',path:'/dsh-draw/try',handler:async(_req,res)=>{
  res.writeHead(410,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:'旧 HTTP 生图入口已关闭，请在主账号会话通过 draw_image 提交需求'}));
 }}));
}
