import {cleanOutgoingText} from './output-control.mjs';

// Only visible text enters here. Keep one ordered buffer per live session/turn.
export function emptyReply(turn = -1) {
  return {轮号:turn, 文本:'', 图们:[], parts:[], seen:[], closed:false};
}
export function appendReply(previous, turn, text, images = []) {
  const state = previous?.轮号 === turn ? previous : emptyReply(turn);
  if (state.closed) return state;
  const raw = String(text || '').trim();
  const cleaned = cleanOutgoingText(raw);
  const parts = [...(state.parts || [])];
  const seen = [...(state.seen || [])];
  if (raw && !seen.includes(raw)) {
    seen.push(raw);
    if (cleaned && !parts.includes(cleaned)) parts.push(cleaned);
  }
  // Keep an explicit silence token for existing scheduler accounting, only if
  // no useful visible reply has been produced in this turn.
  const silence = raw.includes('[PAOPAO_SILENT]') || state.文本.includes('[PAOPAO_SILENT]');
  const pictures = [...state.图们];
  for (const item of images) if (!pictures.some(x=>JSON.stringify(x)===JSON.stringify(item))) pictures.push(item);
  return {...state, parts, seen, 文本:parts.join('\n\n') || (silence ? '[PAOPAO_SILENT]' : ''), 图们:pictures.slice(0,10)};
}

let supplementReceiver;
export function registerSupplementReceiver(receiver) {
  supplementReceiver = receiver;
  return () => { if (supplementReceiver === receiver) supplementReceiver = undefined; };
}
export function queueSupplement(origin, text) {
  if (!supplementReceiver) throw new Error('QQ 正文队列尚未就绪，未发送补充文字');
  const cleaned = cleanOutgoingText(text);
  if (!cleaned) throw new Error('补充文字没有可发送的正文');
  return supplementReceiver(origin, cleaned);
}

// Do not let the next turn interleave bubbles with an unfinished delivery.
export function createDeliveryQueue() {
  const pending = new Map();
  return (key, send) => {
    const result = (pending.get(key) || Promise.resolve()).catch(()=>{}).then(send);
    pending.set(key,result);
    const clear = () => { if (pending.get(key) === result) pending.delete(key); };
    result.then(clear,clear);
    return result;
  };
}
