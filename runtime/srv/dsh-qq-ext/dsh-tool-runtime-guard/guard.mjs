export const LIMITS = Object.freeze({voiceMs:220000, toolMs:45000, drawMs:60000, waitMs:5000, turnMs:90000, maxCalls:8, graceMs:2000});
const exempt = new Set(['qq_reply_gate']);
const failure = (code, message) => ({isError:true, error:{message,info:{code}}, content:[{type:'text',text:message}]});

// Budget only capability execution. Never edit persona, conversation text or inboxes.
export function installGuard(ctx, limits=LIMITS, report=()=>{}) {
  const states = new WeakMap();
  const running = new Set();
  const quarantined = new WeakMap();
  const key = agent => agent?.session ?? agent;
  const state = agent => {
    const k=key(agent);
    if (!k || typeof k!=='object') return undefined;
    if (!states.has(k)) states.set(k,{calls:0,firstAt:0,exhausted:false});
    return states.get(k);
  };
  const blocked = s => s && (s.exhausted || s.calls>=limits.maxCalls || (s.firstAt && Date.now()-s.firstAt>=limits.turnMs));
  ctx.on('session/event',(session,event)=>{
    if(event.type==='turn/start') states.set(session,{calls:0,firstAt:0,exhausted:false});
  });
  ctx.tools.guard(exec=>{
    if(exempt.has(exec.name)) return;
    if(quarantined.get(key(exec.agent))?.has(exec.name)) return '该工具尚未结束取消清理，本轮不要重试；请直接说明当前结果';
    if(blocked(state(exec.agent))) return '本轮工具预算已用完，请直接根据已有结果回复，不再调用工具';
  });
  ctx.on('system-prompt/assemble',async(_assembly,context,next)=>{
    const assembly=await next();
    const agent=context.scope;
    const s=state(agent), q=quarantined.get(key(agent));
    if(!blocked(s) && !q?.size) return assembly;
    return {...assembly,tools:assembly.tools.filter(t=>exempt.has(t.name)||(!blocked(s)&&!q?.has(t.name)))};
  });
  ctx.on('tools/execute',async(exec,next)=>{
    if(exempt.has(exec.name)) return next();
    const s=state(exec.agent);
    if(blocked(s)) return failure('TOOL_BUDGET','本轮工具预算已用完，请直接回复已有结果');
    if(s){s.calls++;s.firstAt ||= Date.now();}
    const remaining=s?limits.turnMs-(Date.now()-s.firstAt):limits.turnMs;
    const ms=exec.name==='qq_send_voice' ? (limits.voiceMs ?? 220000) : Math.max(1,Math.min(remaining,exec.name==='job_output'?limits.waitMs:exec.name==='draw_image'?limits.drawMs:limits.toolMs));
    const original=exec.signal, controller=new AbortController();
    const forward=()=>controller.abort(original.reason);
    original?.addEventListener('abort',forward,{once:true});
    if(original?.aborted) forward();
    exec.signal=controller.signal;
    running.add(controller);
    let timeout=false, settled=false, grace;
    const timer=setTimeout(()=>{timeout=true;controller.abort(new Error('TOOL_RUNTIME_TIMEOUT'));},ms);
    let onAbort;
    const aborted=new Promise(resolve=>{
      onAbort=()=>resolve({aborted:true});
      controller.signal.addEventListener('abort',onAbort,{once:true});
      if(controller.signal.aborted) onAbort();
    });
    const body=Promise.resolve().then(next).then(result=>({result}),error=>({error}));
    const cleanup=()=>{
      settled=true; clearTimeout(timer);clearTimeout(grace);
      controller.signal.removeEventListener('abort',onAbort);
      original?.removeEventListener('abort',forward);
      running.delete(controller);
      // Post-execute freezes the record once an uncooperative call is detached.
      if(Object.getOwnPropertyDescriptor(exec,'signal')?.writable)exec.signal=original;
      quarantined.get(key(exec.agent))?.delete(exec.name);
    };
    body.then(cleanup);
    const first=await Promise.race([body,aborted]);
    if(!first.aborted && !timeout){if(first.error)throw first.error;return first.result;}
    if(!settled) await Promise.race([body,new Promise(resolve=>{grace=setTimeout(resolve,limits.graceMs);})]);
    if(!settled && key(exec.agent)) {
      const k=key(exec.agent);
      if(!quarantined.has(k))quarantined.set(k,new Set());
      quarantined.get(k).add(exec.name);
    }
    if(s)s.exhausted=true;
    report({tool:exec.name,timeout,settled,at:new Date().toISOString()});
    // An uncooperative plugin remains quarantined until its original promise settles.
    // We never claim its external work was cancelled, and never automatically retry it.
    return failure(timeout?'TOOL_RUNTIME_TIMEOUT':'TOOL_RUNTIME_CANCELLED',
      `${exec.name} ${timeout?'等待超时':'已取消'}；${settled?'本次调用已结束':'已发出取消请求，但工具尚未确认结束，已禁止重复调用'}。请据实说明未完成的部分，本轮不要重试`);
  },{prepend:true});
  ctx.on('dispose',()=>{for(const c of running)c.abort(new Error('runtime guard disposed'));});
  return {state};
}
