// Visible-output cleanup only. Never read or attempt to infer model reasoning.
const waitOnly = /^[（(]\s*(?:等(?:待)?|静静等(?:待)?)\s*(?:着)?\s*(?:老哥|哥哥|你|他|对方|用户)\s*(?:再|继续|接着|接下来|往下|着|的|\s)*(?:开口|说话|说|回复|回应|安排|指示|发言|消息|下一句|下文)[~～…\s]*[）)]$/u;

export function cleanOutgoingText(value) {
  const text = String(value || '')
    .replace(/```(?:text|plaintext)?[ \t]*\r?\n\s*\[PAOPAO_SILENT\]\s*\r?\n```/g, '')
    .replace(/(`{1,3}|\*\*|__)\s*\[PAOPAO_SILENT\]\s*\1/g, '')
    .replace(/\[PAOPAO_SILENT\]/g, '');
  let fence = '';
  return text.split(/\r?\n/).filter(line => {
    const marker = line.trim().match(/^(`{3,}|~{3,})/);
    if (marker) { fence = fence ? '' : marker[1][0]; return true; }
    return Boolean(fence) || !waitOnly.test(line.trim());
  }).join('\n').trim();
}

export function splitReplyBubbles(value) {
  const lines = String(value || '').replace(/\r\n/g,'\n').split('\n');
  const result = [];
  let code = [], fence = '';
  for (const line of lines) {
    const trimmed = line.trim(), marker = trimmed.match(/^(`{3,}|~{3,})/);
    if (fence) {
      code.push(line);
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) {
        result.push(code.join('\n')); code = []; fence = '';
      }
    } else if (marker) { fence = marker[1]; code = [line]; }
    else if (trimmed) result.push(trimmed);
  }
  if (code.length) result.push(code.join('\n'));
  // Bound message bursts while retaining all text and the model's first breaks.
  return result.length <= 6 ? result : [...result.slice(0,5),result.slice(5).join('\n')];
}
