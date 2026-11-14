// Visible maintenance exchanges are not evidence about a QQ participant.
export function isMaintenanceMessage(message) {
  if(message?.source?.kind !== 'user') return false;
  const text=typeof message.content==='string' ? message.content : (message.content||[]).filter(b=>b.type==='text').map(b=>b.text||'').join('\n');
  return /维护助手|维护沟通|获准的.*审图|维护复核|老哥已经授权固定创作流程/.test(text);
}
export function isIdentityDriftReply(text) {
  return /我是你的专属营养管家|我可是你的专属营养管家/.test(text);
}
