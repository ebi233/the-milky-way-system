// Inspect protocol types and visible text only; never interpret reasoning.
export function actionable(chunk) {
  if (chunk.type === 'text-delta') return Boolean(chunk.text?.trim());
  if (chunk.type === 'tool-call-delta') return true;
  if (chunk.type === 'block-start') return ['tool-call','image','audio'].includes(chunk.blockType);
  if (chunk.type === 'block-end') return chunk.block?.type === 'text'
    ? Boolean(chunk.block.text?.trim()) : ['tool-call','image','audio'].includes(chunk.block?.type);
  return false;
}
export function eligible(options) {
  if (options.purpose && options.purpose !== 'agent') return false;
  const messages=options.messages||[];
  const index=messages.findLastIndex(m=>m.role==='user'&&!['model-selection','compact-checkpoint'].includes(m.source?.kind));
  return Boolean(options.sessionId && index>=0 && messages[index].source?.kind==='qq' &&
    !messages.slice(index+1).some(m=>m.role==='assistant'||m.role==='tool'));
}
export async function* recoverEmpty(first, retry, record = () => {}) {
  let held=[], released=false, finish, bytes=0;
  for await (const chunk of first) {
    if (chunk.type === 'finish') finish=chunk.reason;
    if (released) { yield chunk; continue; }
    held.push(chunk); bytes+=JSON.stringify(chunk).length;
    if (actionable(chunk) || bytes>8*1024*1024) {
      released=true;
      for(const item of held) yield item;
      held=[];
    }
  }
  if(released || finish?.kind!=='stop') { for(const item of held) yield item; return; }
  record('empty_detected');
  let visible=false, retryFinish;
  // Original response contained no action or user-visible output. Retry once,
  // with the identical input; this cannot replay a tool from the first attempt.
  const firstUsage=held.findLast(x=>x.type==='usage')?.usage;
  held=[];
  for await(const chunk of retry()) {
    visible ||= actionable(chunk);
    if(chunk.type==='finish') {
      retryFinish=chunk.reason;
      if(!visible && retryFinish.kind==='stop') {
        record('empty_failed');
        yield {type:'finish',reason:{kind:'error',failure:{code:'EMPTY_VISIBLE_OUTPUT',message:'Model returned no visible output after one recovery attempt'}}};
        return;
      }
    }
    if(chunk.type==='usage' && firstUsage) {
      const usage={...chunk.usage};
      for(const [key,val] of Object.entries(firstUsage))
        if(typeof val==='number' && typeof usage[key]==='number')usage[key]+=val;
      yield {...chunk,usage};
    } else yield chunk;
  }
  record(visible && retryFinish?.kind==='stop' ? 'empty_recovered' : 'empty_failed');
}
