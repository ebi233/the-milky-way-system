import { requireQQOrigin } from './qq-origin.mjs';

const MEDIA = new Set(['qq_send_voice', 'qq_send_sticker']);
const digits = x => /^\d+$/.test(String(x || ''));
export function requireMediaOrigin(exec, who, tool, args = {}, previous, assertGroup = () => { throw Error('群守卫未就绪'); }) {
  if (!MEDIA.has(tool)) throw Error('该入口仅用于语音与表情包');
  let current;
  if (who?.role === 'owner') {
    if (args.group_id != null) throw Error('私聊不能指定群聊目标');
    current = { ...requireQQOrigin(exec, who, tool, args.user_id), kind: 'private' };
  } else {
    if (who?.role !== 'group' || who.inherited || who.conflict || exec?.signal?.aborted) throw Error('当前会话不能使用群媒体工具');
    const session = exec?.agent?.session;
    if (!session || session.header?.id !== who.session || !digits(who.group)) throw Error('群会话绑定无效');
    if (args.user_id != null || (args.group_id != null && String(args.group_id) !== who.group)) throw Error('只能发送到当前群，不能指定私聊或其他群');
    assertGroup(who);
    let message;
    const events = session.snapshotEvents();
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === 'turn/end') break;
      if (e.type === 'turn/start') {
        if (message && Number.isInteger(e.data?.turn)) current = { kind: 'group', session: who.session, peer: Number(who.group), turn: e.data.turn, message };
        break;
      }
      if (e.type !== 'user/message') continue;
      const d = e.data?.message || e.data;
      const source = d?.source;
      if (d?.role === 'user' && ((source?.kind === 'model-selection' && source.form === 'notice') || (source?.kind === 'agent-instructions' && source.form === 'instructions') || (source?.kind === 'compact-checkpoint' && typeof source.compactionId === 'string' && source.compactionId))) continue;
      if (d?.role !== 'user' || source?.kind !== 'qq' || !d.id) throw Error('没有当前群聊消息，已阻止发送');
      message ??= d.id;
    }
    if (!current) throw Error('当前群聊回合已结束或无可信来源');
  }
  if (previous && ['kind','session','peer','turn','message'].some(k => previous[k] !== current[k])) throw Error('会话或消息来源已经变化，已取消发送');
  return current;
}

export function mediaPayload(origin, message) {
  if (!origin || !digits(origin.peer)) throw Error('无有效发送目标');
  if (origin.kind === 'group') return ['send_group_msg', { group_id: origin.peer, message }];
  if (origin.kind === 'private') return ['send_private_msg', { user_id: origin.peer, message }];
  throw Error('未知媒体目标类型');
}
