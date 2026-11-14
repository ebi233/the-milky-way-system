export const completedDeliveryPolicy='completed-image-notices-removed-v2';
// Runtime projection only: never edit the durable conversation or persona.
export const proactiveHistoryPolicy = 'completed-checks-protocol-safe-v2';
export const triggerAnchor='【历史来源】随后这条回复由当时的自主活动触发；此标记不是用户来信，也不是当前任务。';

export function projectProactiveHistory(messages, events, {owner = false} = {}) {
  const stats = {policy: proactiveHistoryPolicy, removedChecks: 0, removedSilentReplies: 0, removedTextChars: 0, foldedDeliveries: 0, protocolAnchors:0, deliveryPolicy: completedDeliveryPolicy};
  if (!owner) return {messages, stats};
  const byId = new Map();
  let turn = null;
  for (const event of events) {
    if (event.type === 'turn/start') {
      turn = {number: event.data?.turn, ended: false, auto: false, human: false};
    } else if (event.type === 'turn/end') {
      if (turn && event.data?.turn === turn.number) {turn.ended = true;turn.completed=event.data?.reason?.kind==='completed';}
      turn = null;
    } else if (turn && ['user/message', 'assistant/message'].includes(event.type)) {
      const message = event.type === 'user/message' ? event.data : event.data?.message;
      if (!message?.id) continue;
      if (event.type === 'user/message') {
        turn.auto ||= message.source?.kind === 'speak-up';
        turn.human ||= ['qq', 'user'].includes(message.source?.kind);
      }
      byId.set(message.id, {turn, role: message.role, source: message.source?.kind, content: message.content, seq:event.seq, at:event.time});
    }
  }
  const projected = [],removedTriggers=new Map();
  for (const message of messages) {
    const record = byId.get(message.id);
    // Unknown provenance and open turns are retained, including pending tool work.
    if (!record?.turn.ended) { projected.push(message); continue; }
    const content = message.content || [];
    const text = content.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
    if (message.role==='user'&&record.role==='user'&&record.turn.completed&&record.source==='image-handoff-ready'
        &&message.source?.kind==='image-handoff-ready'&&/^[a-f0-9]{32}$/.test(message.source.jobId||'')
        &&content.every(b=>b.type==='text')&&JSON.stringify(content)===JSON.stringify(record.content)) {
      stats.foldedDeliveries++;stats.removedTextChars+=text.length;
      continue;
    }
    if (message.role === 'user' && record.role === 'user' && record.source === 'speak-up' && message.source?.kind === 'speak-up'
        && content.every(b => b.type === 'text')) {
      stats.removedChecks++; stats.removedTextChars += text.length;
      removedTriggers.set(record.turn,[...(removedTriggers.get(record.turn)||[]),{message,record}]);
      continue;
    }
    // Only an exact control-only reply from a completed automatic turn is silence.
    // Spoken words, attachments, tool calls/results, and ordinary quoted markers survive.
    if (message.role === 'assistant' && record.role === 'assistant' && record.turn.auto && !record.turn.human
        && text.trim() === '[PAOPAO_SILENT]' && content.every(b => ['text', 'reasoning'].includes(b.type))) {
      stats.removedSilentReplies++; stats.removedTextChars += text.length;
      continue;
    }
    projected.push(message);
  }
  // In-history system updates must precede an assistant only after a user/tool
  // turn. Removing an automatic trigger can orphan such an update. Preserve
  // just its authenticated historical provenance, never its old instructions.
  let pendingUpdate=false,lastWire=null;
  const safe=[];
  for(const message of projected){
    if(message.role==='system'||message.role==='developer'){
      if(lastWire!==null&&message.content?.some(b=>b.type!=='text'||b.text))pendingUpdate=true;
      safe.push(message);continue;
    }
    const substantive=message.role==='tool'||message.content?.some(b=>b.type==='text'?Boolean(b.text):message.role==='assistant'||b.type!=='reasoning');
    if(!substantive){safe.push(message);continue;}
    if(message.role==='assistant'){
      if(pendingUpdate&&lastWire!=='user'){
        const record=byId.get(message.id),trigger=record&&(removedTriggers.get(record.turn)||[]).findLast(t=>Number.isInteger(t.record.seq)&&t.record.seq<record.seq);
        if(trigger&&record.turn.auto&&!record.turn.human&&record.turn.completed){
          safe.push({...trigger.message,source:{...trigger.message.source,projection:'historical-trigger-anchor-v1'},content:[{type:'text',text:triggerAnchor}]});
          stats.protocolAnchors++;lastWire='user';
        }
      }
      pendingUpdate=false;lastWire='assistant';
    }else if(message.role==='user'||message.role==='tool')lastWire='user';
    safe.push(message);
  }
  return {messages: stats.removedChecks || stats.removedSilentReplies || stats.foldedDeliveries ? safe : messages, stats};
}
