#!/usr/bin/env node
/**
 * roleplay.js — 酒馆-讲述者原型（单对话单角色）
 *
 * 用法:
 *   node roleplay.js <card_id_or_dir>            # 交互模式（输入 退出/quit 结束）
 *   node roleplay.js <card_id_or_dir> "消息"      # 单轮模式
 *
 * 每轮流程:
 *   1. 首次运行时把 first_mes 作为开场白写入 chat.jsonl 并展示
 *   2. 追加用户消息 → 按 8 段模板组装上下文 → 调用 DeepSeek API 生成回复
 *   3. 追加回复到 chat.jsonl → 第二次模型调用生成 state.json 增量 → 落盘
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

const dshHome = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const tavernCards = () => path.join(dshHome(), 'tavern', 'cards')


// ---------------------------------------------------------------- 配置
const CARD_ID = process.argv[2];
const ONE_SHOT = process.argv[3];
if (!CARD_ID) { console.error('用法: node roleplay.js <card_id_or_dir> ["消息"]'); process.exit(1); }

const BASE_DIR = tavernCards();
const cardDir = path.isAbsolute(CARD_ID)
  ? CARD_ID
  : path.join(BASE_DIR, fs.readdirSync(BASE_DIR).find(d => d.startsWith(CARD_ID) || d.includes(CARD_ID)) || '');
if (!fs.existsSync(cardDir)) { console.error(`找不到卡目录: ${CARD_ID}`); process.exit(1); }

const CHAR_NAME = fs.readdirSync(cardDir).includes('meta.json')
  ? JSON.parse(fs.readFileSync(path.join(cardDir, 'meta.json'), 'utf8')).card.name
  : 'Blanche';
const storyMd = fs.readFileSync(path.join(cardDir, 'story.md'), 'utf8');
const chatFile = path.join(cardDir, 'chat.jsonl');
const stateFile = path.join(cardDir, 'state.json');
const summaryFile = path.join(cardDir, 'summary.md');

const ctxTokens = 16000;
const replyTokens = 700;
const budget = ctxTokens - replyTokens;

// ---------------------------------------------------------------- 工具
const section = (md, name) => {
  const m = md.match(new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |\\Z)`, 'm'));
  return m ? m[1].trim() : '';
};
const subst = s => String(s).replace(/\{\{char\}\}/gi, CHAR_NAME).replace(/\{\{user\}\}/g, '你');
const estTokens = s => Math.ceil((s || '').length / 3) + 4; // 粗略估算（中英混合）

let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const chat = fs.existsSync(chatFile)
  ? fs.readFileSync(chatFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  : [];

// ---------------------------------------------------------------- 范例对话解析（ST parseExampleIntoIndividual 精简版）
function parseExamples(md) {
  const raw = section(md, '范例对话');
  if (!raw) return [];
  const text = subst(raw).replace(/^```\n?/, '').replace(/\n```\s*$/, '');
  const blocks = text.split(/<START>/i).map(b => b.trim()).filter(Boolean);
  const out = [];
  for (let bi = 0; bi < blocks.length && out.length < 12; bi++) {
    const block = blocks[bi];
    if (bi === 0) {
      // 首块常含说明行，跳过第一行
    }
    let cur = null;
    const push = (name, role) => { cur = { role, name, content: [] }; out.push(cur); };
    for (const line of block.split('\n')) {
      const u = line.match(/^你[:：]\s*(.*)$/);
      const c = line.match(new RegExp(`^${CHAR_NAME}[:：]\\s*(.*)$`));
      if (u) { push('你', 'user'); if (u[1]) cur.content.push(u[1]); }
      else if (c) { push(CHAR_NAME, 'assistant'); if (c[1]) cur.content.push(c[1]); }
      else if (cur && line.trim()) cur.content.push(line);
    }
  }
  return out.filter(e => e.content.length).map(e => ({ role: e.role, name: e.name, content: e.content.join('\n').trim() }));
}

// ---------------------------------------------------------------- 组装（8 段模板）
function assemble() {
  const sys = (content) => ({ role: 'system', content });
  const msgs = [];

  const main = `你正在扮演【${CHAR_NAME}】，与用户（你）进行一场沉浸式文字角色扮演。
严格遵循 story.md 中【身份档案】【性格】【说话风格】【创作约束】的要求，绝不跳出角色、绝不自称AI。
用用户使用的语言回复；描述动作/表情/环境用第三人称叙述，人物对话加引号。`;
  msgs.push(sys(main));

  const idDesc = section(storyMd, '身份档案');
  const personality = section(storyMd, '性格');
  const speech = section(storyMd, '说话风格');
  const scenario = section(storyMd, '场景与开端');
  const lore = section(storyMd, '世界观与背景');
  const stateDoc = section(storyMd, '状态说明');

  if (idDesc) msgs.push(sys(`【身份档案】\n${idDesc}`));
  if (personality) msgs.push(sys(`【性格】\n${personality}`));
  if (speech) msgs.push(sys(`【说话风格】（必须遵循，这是风格的硬性要求）\n${speech}`));
  if (scenario) msgs.push(sys(`【场景与开端】\n${scenario}`));
  if (lore) msgs.push(sys(`【世界观与背景】\n${lore}`));

  if (fs.existsSync(summaryFile)) {
    msgs.push(sys(`[Summary: ${fs.readFileSync(summaryFile, 'utf8').trim()}]`));
  }

  // 范例对话（靠近历史，供风格参考）
  const examples = parseExamples(storyMd);
  for (const ex of examples) msgs.push({ role: ex.role, name: ex.name === '你' ? undefined : ex.name, content: ex.content });

  // 状态 + 历史后指令（control，最后注入）
  msgs.push(sys(`【当前状态】\n${JSON.stringify(state, null, 0)}\n\n剧情推进后必须依据【状态说明】更新 state.json（由单独调用完成），本消息仅作参考。`));

  // 历史：从新往旧贪心填充
  const used = msgs.reduce((n, m) => n + estTokens(m.content), 0);
  let remain = budget - used;
  const hist = [...chat].reverse();
  const filled = [];
  for (const m of hist) {
    const t = estTokens(m.mes);
    if (remain - t < 200) break;
    filled.unshift({ role: m.role, name: m.role === 'assistant' ? m.name : undefined, content: m.mes });
    remain -= t;
  }
  return [...msgs, ...filled];
}

// ---------------------------------------------------------------- API 调用
const KEY = fs.readFileSync(path.join(dshHome(), '.credentials.yaml'), 'utf8')
  .match(/^DEEPSEEK_API_KEY:\s*(.+)$/m)?.[1].trim().replace(/["']/g, '');
if (!KEY) { console.error('找不到 DEEPSEEK_API_KEY'); process.exit(1); }

async function callLLM(messages, { max_tokens = replyTokens, temperature = 0.9, jsonMode = false } = {}) {
  const body = { model: 'deepseek-v4-flash', messages, max_tokens, temperature, stream: false, thinking: { type: 'disabled' } };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices[0].message.content ?? '';
}

// ---------------------------------------------------------------- 状态更新
async function updateState(userMsg, reply) {
  const stateDoc = section(storyMd, '状态说明');
  const recent = chat.slice(-6).map(m => `${m.role === 'assistant' ? CHAR_NAME : '你'}: ${m.mes}`).join('\n');
  const prompt = [
    `你是状态机维护器。依据下面的状态说明，根据最近剧情更新 state.json 中【确实发生了变化】的键。`,
    `只输出一个 JSON 对象，包含要更新的键；未变化的键不要出现。affection 必须严格由剧情驱动，不许凭空加分。`,
    ``,
    `【状态说明】\n${stateDoc || '(无)'}`,
    ``,
    `【当前 state.json】\n${JSON.stringify(state)}`,
    ``,
    `【最近剧情】\n${recent}\n用户: ${userMsg}\n${CHAR_NAME}: ${reply}`,
  ].join('\n');
  try {
    const out = await callLLM([{ role: 'user', content: prompt }], { max_tokens: 500, temperature: 0.2, jsonMode: true });
    const diff = JSON.parse(out.replace(/```json|```/g, '').trim());
    const allowed = { affection: 'number', mood: 'string', location: 'string', relationship: 'string', flags: 'object', scene: 'string', notes: 'string' };
    let changed = false;
    for (const [k, v] of Object.entries(diff)) {
      if (!(k in allowed) || typeof v !== allowed[k]) continue;
      if (k === 'affection') state.affection = Math.max(-10, Math.min(10, v));
      else if (k === 'notes') state.notes = String(v).slice(0, 100);
      else state[k] = v;
      changed = true;
    }
    if (changed) fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error(`  (状态更新失败，已跳过: ${e.message.slice(0, 80)})`);
  }
}

// ---------------------------------------------------------------- 主流程
function appendChat(role, name, mes) {
  chat.push({ role, name, mes, ts: new Date().toISOString() });
  fs.appendFileSync(chatFile, JSON.stringify({ role, name, mes, ts: chat[chat.length - 1].ts }) + '\n');
}

function show(msg, who) {
  console.log(`\n${'='.repeat(40)}`);
  console.log(`【${who}】`);
  console.log(msg);
}

async function turn(userMsg) {
  appendChat('user', null, userMsg);
  const msgs = assemble();
  const reply = await callLLM(msgs);
  appendChat('assistant', CHAR_NAME, reply);
  show(reply, CHAR_NAME);
  await updateState(userMsg, reply);
  console.log(`\n(state.json: affection=${state.affection}, mood=${state.mood}, location=${state.location}, scene=${state.scene})`);
}

async function main() {
  if (chat.length === 0) {
    const opening = subst(section(storyMd, '开场白'));
    appendChat('assistant', CHAR_NAME, opening);
    show(opening, `${CHAR_NAME} · 开场`);
  }

  if (ONE_SHOT) {
    await turn(ONE_SHOT);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\n（输入 退出/quit 结束）');
  const loop = () => rl.question('你 > ', async (input) => {
    if (/^(退出|quit|exit)$/i.test(input.trim())) return rl.close();
    try { await turn(input.trim()); } catch (e) { console.error(`错误: ${e.message}`); }
    loop();
  });
  loop();
}

main().catch(e => { console.error(e.message); process.exit(1); });
