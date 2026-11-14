// Use trusted, current-turn session events, never model text or stale disk receipts.
export function qqOrigin(exec, who) {
  if (!exec?.agent || exec.signal?.aborted || who?.role !== 'owner' || who.inherited) return null;
  const session = exec.agent.session;
  if (!session || session.header?.id !== who.session || !/^\d+$/.test(String(who.qq))) return null;
  try {
    const events = session.snapshotEvents();
    let message = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === 'turn/end') return null;
      if (event.type === 'turn/start') {
        if (!message || !Number.isInteger(event.data?.turn)) return null;
        return { session: who.session, peer: Number(who.qq), turn: event.data.turn, message };
      }
      if (event.type !== 'user/message') continue;
      const input = event.data?.message || event.data;
      // Native informational messages use the user role but are not new senders.
      // Their source metadata is set by the harness, never inferred from text.
      const source = input?.source;
      const notice = input?.role === 'user' && (
        (source?.kind === 'model-selection' && source.form === 'notice') ||
        (source?.kind === 'agent-instructions' && source.form === 'instructions') ||
        (source?.kind === 'compact-checkpoint' && typeof source.compactionId === 'string' && source.compactionId.length > 0)
      );
      if (notice) continue;
      if (input?.role !== 'user' || input.source?.kind !== 'qq' || !input.id) return null;
      message ??= input.id;
    }
  } catch {}
  return null;
}

export function requireQQOrigin(exec, who, tool, recipient, previous) {
  const current = qqOrigin(exec, who);
  if (!current) throw new Error(`无法确认 ${tool} 属于当前 QQ 私聊回合，已阻止发送。不要据此判断用户来自微信或桌面，也不要声称已经发送。`);
  if (recipient != null && recipient !== '' && Number(recipient) !== current.peer)
    throw new Error('只能发送给当前已核实的 QQ 私聊对象');
  if (previous && (current.session !== previous.session || current.turn !== previous.turn || current.message !== previous.message || current.peer !== previous.peer))
    throw new Error('会话或消息来源已经变化，已取消这次发送');
  return current;
}
