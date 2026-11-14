import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {assertTrustedGroup} from '../../dsh-qq-ext/dsh-long-memory/lib/group-privacy.mjs';

const home=process.env.DSH_HOME || join(homedir(),'.dsh');
const file=join(home,'group-card-state.json');
const HOUR=60*60*1000;
export function makeCard(suffix) {
  if(typeof suffix!=='string')throw new Error('只填写简短后缀，空字符串表示恢复泡泡');
  if(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(suffix))throw new Error('后缀不能包含换行或控制字符');
  const value=suffix.normalize('NFC').trim();
  if([...value].length>8 || /[^\p{L}\p{N}\p{M}\p{So} ·]/u.test(value))
    throw new Error('后缀最多八个字，不包含换行、链接或控制字符');
  return value?'泡泡｜'+value:'泡泡';
}
function state(){
  try{
    const data=JSON.parse(readFileSync(file,'utf8'));
    if(data.version!==1 || !data.groups || Array.isArray(data.groups) || typeof data.groups!=='object')throw new Error();
    return data;
  }catch(e){if(e.code==='ENOENT')return {version:1,groups:{}};throw new Error('名片状态暂不可用，先保持原样');}
}
function remember(group,entry){
  const data=state();data.groups[group]=entry;
  mkdirSync(home,{recursive:true,mode:0o700});
  const temp=file+'.'+randomUUID()+'.tmp';
  writeFileSync(temp,JSON.stringify(data,null,2)+'\n',{mode:0o600});renameSync(temp,file);
}
export function makeSelfGroupCard({readConfig,requestHeaders}){
  const busy=new Set();
  return {
    name:'qq_set_own_group_card',
    description:'偶尔按自己的心情修改本群里你自己的群名片，只填写最多八个字的日常状态后缀；固定保留泡泡。空后缀恢复泡泡。一小时最多尝试一次。不是每轮必做，不接受群号、成员号或改他人资料。确认成功再说已改；失败就保留原样，不反复重试。',
    parameters:{type:'object',properties:{suffix:{type:'string',description:'最多八个字的普通日常状态，例如摸鱼中；空字符串恢复泡泡'}},required:['suffix'],additionalProperties:false},
    output:{schema:{type:'object',properties:{},additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},
    async execute(args,exec){
      if(!args || Array.isArray(args) || Object.keys(args).some(k=>k!=='suffix'))throw new Error('只能填写 suffix，不能指定目标群或成员');
      const card=makeCard(args.suffix);
      const sid=String(exec?.agent?.session?.header?.id || exec?.agent?.session?.id || exec?.agent?.id || '');
      const conf=readConfig();
      const row=(conf.绑定||[]).find(x=>x.类型==='群' && x.会话===sid);
      if(!row)throw new Error('只能在已登记的群会话里修改自己的群名片');
      assertTrustedGroup(row,conf);
      if(!conf.总开关 || conf.试运行)return {ok:false,changed:false,reason:'群桥接未启用实际操作'};
      const group=String(row.号码);
      const groupNumber=Number(group);
      if(!Number.isSafeInteger(groupNumber) || groupNumber<=0)throw new Error('群号无效');
      if(busy.has(group))return {ok:false,changed:false,reason:'本群名片正在处理'};
      busy.add(group);
      try{
        const validate=()=>{
          if(exec?.signal?.aborted)throw new Error('本轮已结束，取消修改');
          const current=readConfig();
          const bound=(current.绑定||[]).find(x=>x.类型==='群' && x.会话===sid && String(x.号码)===group);
          if(!bound || current.NapCat!==conf.NapCat || current.令牌!==conf.令牌 || !current.总开关 || current.试运行)
            throw new Error('群绑定或连接已改变，未继续修改');
          assertTrustedGroup(bound,current);
        };
        const request=async(action,body)=>{
          validate();
          const response=await fetch(conf.NapCat.replace(/\/$/,'')+'/'+action,{
            method:'POST',headers:requestHeaders(conf),body:JSON.stringify(body),signal:AbortSignal.timeout(8000),
          });
          if(!response.ok)throw new Error('QQ 名片接口暂时不可用');
          const result=await response.json();
          if(result.status!=='ok' || result.retcode!==0)throw new Error('QQ 未确认操作成功，请保持原样');
          return result.data;
        };
        const self=String((await request('get_login_info',{}))?.user_id || '');
        if(!/^\d+$/.test(self) || !Number.isSafeInteger(Number(self)) || Number(self)<=0)throw new Error('无法确认自己的 QQ 账号');
        const target={group_id:groupNumber,user_id:Number(self),no_cache:true};
        const info=await request('get_group_member_info',target);
        const checkMember=data=>{
          if(String(data?.user_id)!==self || String(data?.group_id)!==group)throw new Error('群成员身份核验不一致');
        };
        checkMember(info);
        if(info.card===card)return {ok:true,changed:false,card};
        if(info.card_changeable===false)return {ok:false,changed:false,reason:'群设置不允许修改名片，保持原样'};
        const last=state().groups[group];
        if(last && (!Number.isFinite(last.attemptAt) || Date.now()-last.attemptAt<HOUR))
          return {ok:false,changed:false,reason:'名片一小时最多调整一次，先保持原样'};
        validate();
        // Persist the attempt BEFORE the external write, so failures/restarts cannot loop.
        remember(group,{attemptAt:Date.now(),card,status:'pending'});
        await request('set_group_card',{group_id:groupNumber,user_id:Number(self),card});
        const updated=await request('get_group_member_info',target);checkMember(updated);
        if(updated.card!==card)return {ok:false,changed:null,reason:'请求已提交但尚未确认名片更新，不要声称已经改好或重复尝试'};
        remember(group,{attemptAt:state().groups[group].attemptAt,card,status:'confirmed'});
        return {ok:true,changed:true,card};
      }catch{
        return {ok:false,changed:null,reason:'名片修改未确认成功，先保持原样，不声称成功、不重复尝试'};
      }finally{busy.delete(group);}
    },
  };
}
