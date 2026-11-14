import {home,identity} from './access.js';
import {createNeedStore,renderNeed} from './capability-store.mjs';
export {renderNeed};
function owner(agent){
  const who=identity(agent);
  if(who.role!=='owner'||who.inherited||who.conflict||!/^\d+$/.test(who.qq))throw Error('需求记录仅限主账号直接私聊');
  return who;
}
export function offerNeed(agent,scope,now=Date.now()){
  if(scope!=='private')return null;
  try{return createNeedStore({home,subject:owner(agent).qq,now:()=>now}).offer();}catch{return null;}
}
export function registerCapabilityNeeds(register){
  register({
    name:'capability_note',
    description:'可选的未完成兴趣/能力需求记录。只有你确实想做某件事且遇到阻碍、觉得值得以后再提时才 save；不要求产生需求，不自动记录每次失败。先用现有工具/按需加载确认，区分缺少能力、临时故障、需登录授权、尚未确认；不要把未知工具或超时说成缺能力。只写简短事实，不含凭据、原始错误日志或其他会话隐私。保存后私聊活动检查偶尔提供一条，你自由决定是否向老哥提出，不自动安装/付费/授权。解决用 resolve；不再想做或对方拒绝用 dismiss。尊重现有人设、【边界】与权限。',
    parameters:{action:{type:'string',enum:['save','list','resolve','dismiss']},id:{type:'string'},goal:{type:'string',description:'真想做的具体事情，最多100字'},capability:{type:'string',description:'需要的能力，最多80字'},kind:{type:'string',enum:['missing_capability','temporary_failure','access_required','uncertain']},evidence:{type:'string',description:'实际尝试和阻碍的简述，最多160字；未试过如实写'},checked_existing:{type:'boolean',description:'只有实际核对过已安装工具/按需加载后才填true'}},
    output:{schema:{type:'object',properties:{},additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},
    isConcurrencySafe:()=>false,
    async execute(args,exec){
      exec?.signal?.throwIfAborted();const who=owner(exec?.agent),store=createNeedStore({home,subject:who.qq});
      if(args.action==='list')return store.list();
      if(args.action==='save')return store.save(args);
      if(args.action==='resolve'||args.action==='dismiss')return store.close(args.id,args.action==='resolve'?'resolved':'dismissed');
      throw Error('未知需求记录操作');
    },
  });
}
