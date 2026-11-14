import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {readObject,writeObject} from './runtime-state.mjs';

const home=process.env.DSH_HOME||join(homedir(),'.dsh');
const file=join(home,'qq-channel-health.json');
export function readChannelHealth(now=Date.now()){
  try{
    const s=readObject(file,{});
    if(s.version!==1||!Number.isFinite(s.checkedAt)||now<s.checkedAt||now-s.checkedAt>90000)return {status:'unknown',ready:false,explanation:'QQ 连接状态尚未确认或已过期'};
    return s;
  }catch{return {status:'unknown',ready:false,explanation:'QQ 连接状态无法读取'};}
}
export function createChannelHealth({request=globalThis.fetch,now=Date.now,persist=()=>{}}={}){
  let latest=null,flight=null,identity='';
  const status=()=>latest||{status:'unknown',ready:false,explanation:'QQ 连接尚未检查'};
  return {status,check(conf,{force=false}={}){
    const key=createHash('sha256').update(JSON.stringify([conf.NapCat,conf.令牌])).digest('hex');
    if(flight)return flight;
    if(!force&&key===identity&&latest&&now()-latest.checkedAt>=0&&now()-latest.checkedAt<20000)return Promise.resolve(latest);
    identity=key;
    flight=(async()=>{
      const previous=latest;let outcome;
      try{
        const r=await request(String(conf.NapCat).replace(/\/$/,'')+'/get_status',{method:'POST',headers:{'content-type':'application/json',...(conf.令牌?{Authorization:'Bearer '+conf.令牌}:{})},body:'{}',signal:AbortSignal.timeout(4000)});
        if(!r.ok){outcome={status:r.status===401||r.status===403?'auth_error':'transport_error',ready:false};}
        else{
          const j=await r.json();
          outcome=j.status==='ok'&&j.retcode===0&&j.data?.online===true&&j.data?.good!==false?{status:'online',ready:true}:{status:j.status==='ok'&&j.data?.online===false?'login_required':'unavailable',ready:false};
        }
      }catch{outcome={status:'transport_error',ready:false};}
      const labels={online:'QQ 在线，接口可用',login_required:'QQ 已掉线，需要重新登录',transport_error:'QQ 接口无法连接',auth_error:'QQ 接口鉴权失败',unavailable:'QQ 接口返回异常或尚未就绪'};
      latest={version:1,...outcome,explanation:labels[outcome.status],checkedAt:now(),since:previous?.status===outcome.status?previous.since:now(),consecutiveFailures:outcome.ready?0:(previous?.consecutiveFailures||0)+1,lastOnlineAt:outcome.ready?now():previous?.lastOnlineAt||null};
      try{persist(latest)}catch{latest.persistenceError=true;}
      return latest;
    })().finally(()=>{flight=null});
    return flight;
  }};
}
export const qqHealth=createChannelHealth({request:(...args)=>globalThis.fetch(...args),persist:s=>writeObject(file,s)});
