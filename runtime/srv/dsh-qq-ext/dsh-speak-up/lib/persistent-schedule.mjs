import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {randomMinutes,randomWindow} from './random-schedule.mjs';
export function createPersistentSchedule(file,{now=Date.now,random=Math.random}={}){
  let state={version:1,users:{},lastSpokeAt:0},restored=false,storageError=false;
  try{const v=JSON.parse(readFileSync(file,'utf8'));if(v.version!==1 || !v.users || Array.isArray(v.users))throw new Error();state=v;restored=true;}
  catch(e){storageError=e.code!=='ENOENT';}
  const persist=()=>{
    try{mkdirSync(dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(state)+'\n',{mode:0o600});renameSync(temp,file);storageError=false;}
    catch{storageError=true;}
  };
  const key=c=>JSON.stringify([c.随机最短分钟,c.随机最长分钟,c.分时随机,c.凌晨最短分钟,c.凌晨最长分钟,c.峰谷时区,[...(c.目标会话||[])].sort()]);
  const retryReasons=new Set(['channel_unavailable','busy_or_unmounted','preflight_failed']);
  function retry(reason){
    state.retryCount=Math.min(10,(Number(state.retryCount)||0)+1);
    state.nextAt=now()+Math.min(5,2**Math.min(3,state.retryCount-1))*60000;
    state.scheduledAt=now();state.reason='retry:'+reason;state.pending=null;persist();
  }
  // A crash before submission can be retried. An uncertain submission cannot.
  if(state.pending?.phase==='checking')retry('interrupted_preflight');
  else if(state.pending){state.reason='submission_unknown';state.pending=null;persist();}
  function plan(config,{reset=false,reason='resume'}={}){
    const stamp=now(),signature=key(config),window=randomWindow(config,new Date(stamp)),max=window.max*60000;
    if(reset || state.signature!==signature || !Number.isFinite(state.nextAt) || state.nextAt>stamp+max+60000){
      state={...state,signature,nextAt:stamp+randomMinutes(config,random,new Date(stamp))*60000,scheduledAt:stamp,window,reason,pending:null,retryCount:0};persist();
    }
    return Math.max(1000,state.nextAt-stamp);
  }
  return {
    plan,
    claim(config){
      const count=state.retryCount||0;plan(config,{reset:true,reason:'timer'});
      const token=randomUUID();state.retryCount=count;state.pending={token,phase:'checking',at:now()};persist();return token;
    },
    submitting(token){if(state.pending?.token!==token)return;state.pending.phase='submitting';persist();},
    settle(token,reason){
      if(state.pending?.token!==token)return;
      if(state.pending.phase==='checking'&&retryReasons.has(reason)){retry(reason);return;}
      state.pending=null;state.retryCount=0;state.reason=reason||'submission_unknown';persist();
    },
    user(id,time){state.users[id]=Number(time)||now();const rows=Object.entries(state.users).sort((a,b)=>b[1]-a[1]).slice(0,100);state.users=Object.fromEntries(rows);persist();},
    spoke(time){state.lastSpokeAt=Number(time)||now();persist();},
    activity:()=>({users:{...state.users},lastSpokeAt:Number(state.lastSpokeAt)||0}),
    status:()=>({retryPolicy:'transient-preflight-retry-v1',retryCount:Number(state.retryCount)||0,pendingPhase:state.pending?.phase||null,persistent:!storageError,restored,nextAt:Number.isFinite(state.nextAt)?state.nextAt:null,remainingMinutes:Number.isFinite(state.nextAt)?Math.max(0,state.nextAt-now())/60000:null,reason:state.reason||null,window:state.window||null}),
  };
}
