// Resume only the explicitly bound owner room; never prompt or copy history.
export function createOwnerWarmup(ctx,readConfig,{now=Date.now}={}){
  let lastSession='',lastAttempt=-Infinity,pending=null;
  let state={ready:false,reason:'not_checked'};
  async function run(){
    const c=readConfig(),owner=String(c.主人号码||'');
    if(!c.总开关 || c.试运行){state={ready:false,reason:'disabled'};return}
    const rows=Array.isArray(c.绑定)?c.绑定:[];
    const own=rows.filter(b=>b.类型==='私聊' && String(b.号码)===owner);
    const ids=[...new Set(own.map(b=>b.会话))];
    if(!/^\d+$/.test(owner)||ids.length!==1||!/^session-[a-zA-Z0-9-]+$/.test(ids[0])||rows.some(b=>b.会话===ids[0]&&(b.类型!=='私聊'||String(b.号码)!==owner))){state={ready:false,reason:'binding_conflict'};return}
    const sid=ids[0];
    if(ctx.agents?.get?.(sid)){state={ready:true,reason:'mounted'};return}
    if(pending)return pending;
    if(sid===lastSession && now()-lastAttempt<60000)return;
    if(typeof ctx.sessionController?.resolveAgent!=='function'){state={ready:false,reason:'resume_unavailable'};return}
    lastSession=sid;lastAttempt=now();state={ready:false,reason:'resuming'};
    pending=(async()=>{
      try{await ctx.sessionController.resolveAgent(sid);state={ready:!!ctx.agents?.get?.(sid),reason:ctx.agents?.get?.(sid)?'mounted':'not_mounted'}}
      catch{state={ready:false,reason:'resume_failed'}}
      finally{pending=null}
    })();
    return pending;
  }
  return {run,status:()=>({...state})};
}
