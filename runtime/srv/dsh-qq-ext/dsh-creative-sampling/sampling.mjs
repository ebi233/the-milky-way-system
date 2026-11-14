import { readFileSync } from 'node:fs';

const PREFIX = 'DEEPSEEK_';
const ALLOWED = new Set(['TEMPERATURE', 'PRESENCE_PENALTY', 'MAX_TOKENS', 'CHAT_THINKING', 'CHAT_SESSION_IDS']);

export function parseSettings(text) {
  const values = {};
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?DEEPSEEK_([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (!match || !ALLOWED.has(match[1])) continue;
    const key = match[1];
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate ${PREFIX}${key}`);
    const value = match[2].match(/^(?:"([^"]*)"|'([^']*)'|([^#]*?))\s*(?:#.*)?$/);
    if (!value) throw new Error(`Invalid ${PREFIX}${key}`);
    values[key] = (value[1] ?? value[2] ?? value[3]).trim();
  }
  const number = (key, min, max, integer = false) => {
    if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(values[key] ?? '')) {
      throw new Error(`Missing or invalid ${PREFIX}${key}`);
    }
    const result = Number(values[key]);
    if (!Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) {
      throw new Error(`Out of range ${PREFIX}${key}`);
    }
    return result;
  };
  if (!['off','on'].includes(values.CHAT_THINKING)) throw new Error('CHAT_THINKING must be on or off');
  const sessionIds = (values.CHAT_SESSION_IDS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (!sessionIds.length || sessionIds.some(x => !/^session-[a-zA-Z0-9-]{1,100}$/.test(x))) {
    throw new Error('CHAT_SESSION_IDS must list explicit chat session IDs');
  }
  return Object.freeze({
    temperature: number('TEMPERATURE', 0, 2),
    maxTokens: number('MAX_TOKENS', 1, 393216, true),
    requestedPresencePenalty: number('PRESENCE_PENALTY', -2, 2),
    presencePenaltyApplied: false,
    reasoningEffort: values.CHAT_THINKING === 'on' ? 'high' : 'off',
    sessionIds: Object.freeze(sessionIds),
  });
}

export function loadSettings(path) {
  return parseSettings(readFileSync(path, 'utf8'));
}

export function tuneRequest(previous, sessionId, settings) {
  if (previous.provider !== 'deepseek-official' || !['deepseek-v4-pro', 'deepseek-flash', 'deepseek-v4-flash'].includes(previous.model)
      || !settings.sessionIds.includes(sessionId)) return previous;
  if(settings.reasoningEffort !== 'off')return {...previous,reasoningEffort:settings.reasoningEffort};
  return {
    ...previous,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    reasoningEffort: settings.reasoningEffort,
  };
}
