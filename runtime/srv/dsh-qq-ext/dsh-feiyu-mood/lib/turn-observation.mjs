// Read only one actual conversation turn, never a tool catalogue or an older turn.
import {createHash} from 'node:crypto';
export const turnPolicy = 'owner-visible-turn-v3';
const contextKinds = new Set(['runtime-context', 'time-context', 'system-reminder',
  'system', 'time-sampled', 'agent-instructions', 'skill-catalog', 'tool-registry',
  'system-prompt', 'compact-checkpoint']);
const humanKinds = new Set(['user', 'qq', 'qq-bridge', 'fishbuddy']);
const data = e => e?.payload ?? e?.data ?? {};
const type = e => e?.type ?? e?.kind;
export function visibleText(value) {
  if (value?.message) return visibleText(value.message);
  if (typeof value?.content === 'string') return value.content;
  if (Array.isArray(value?.content)) return value.content.filter(b => b?.type === 'text').map(b => b.text || '').join('\n');
  return typeof value?.text === 'string' ? value.text : '';
}
function bounds(events, expectedTurn) {
  const start = events.findLastIndex(e => type(e) === 'turn/start');
  if (expectedTurn !== undefined && (start < 0 || data(events[start]).turn !== expectedTurn)) return null;
  const end = events.findLast(e => type(e) === 'turn/end');
  if (start >= 0 && end && events.indexOf(end) > start && data(end).reason?.kind !== 'completed') return null;
  return start;
}
export function selectInput(events, {turn, clean = s => s} = {}) {
  const start = bounds(events, turn);
  if (start === null) return null;
  for (let i = events.length - 1; i > start; i--) {
    const event = events[i];
    if (type(event) !== 'user/message') continue;
    const message = data(event).message ?? data(event), source = String(message.source?.kind || '');
    if (contextKinds.has(source)) continue;
    // Actual schedules, subagents and unknown senders stop lookup: no fallback to an old human.
    if (!humanKinds.has(source)) return null;
    const full = clean(visibleText(message)), text = full.slice(0, 1600);
    if (!text || source === 'user' && /维护助手|维护沟通|获准的.*审图|维护复核|老哥已经授权固定创作流程/.test(text)) return null;
    const stamp=event.time??event.timestamp??event.at??message.createdAt??message.at;
    const at=typeof stamp==='number'?stamp:Date.parse(stamp);
    return {text, sourceKind: 'user', index: i,
      provenance:{kind:source,messageId:typeof message.id==='string'?message.id.slice(0,160):null,turn:turn??(start>=0?data(events[start]).turn:null),at:Number.isFinite(at)&&at>0?at:null,inputTruncated:full.length>1600},
      eventId: createHash('sha256').update(String(message.id || event.id || event.seq || event.at || i) + '\0' + text).digest('hex')};
  }
  return null;
}
export function readAssessmentTurn(events, options = {}) {
  const input = selectInput(events, options);
  if (!input) return null;
  const replies = events.slice(input.index + 1).filter(e => type(e) === 'assistant/message');
  const final = replies.at(-1);
  const finish = data(final).stream?.map(s => s.chunk).filter(c => c?.type === 'finish').at(-1);
  if (!final || data(final).interrupted || finish?.reason?.kind !== 'stop') return null;
  const fullReply = replies.filter(e => !data(e).interrupted).map(e => visibleText(data(e))).filter(Boolean).join('\n');
  const reply=fullReply.slice(0,1800);
  if (!reply.trim() || /^\s*\[PAOPAO_SILENT\]\s*$/.test(reply)) return null;
  const {index, ...info} = input;
  return {...info, reply,provenance:{...info.provenance,replyTruncated:fullReply.length>1800}};
}
