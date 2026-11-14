#!/usr/bin/env node
/**
 * polish-story.js — card-analyst 模型精修步骤（把即席补全固化为可复现流程）
 *
 * 输入: 已由 parse-card.js 生成的卡目录（含 story.md / meta.json / state.json / analysis-log.md）
 * 流程: 模型基于【身份档案/场景与开端/开场白/范例对话】归纳：
 *        1. 「性格」小节（≤6 条，须有原文证据）
 *        2. 「说话风格」小节（≤6 条规则；无 mes_example 时标注「推断」）
 *        3. state.json 初始化精修（location/scene/mood/relationship/notes）
 * 约束: 原文小节（身份档案/场景/开场白/世界观/范例对话）一字不动；产出以结构化 JSON 返回后落盘。
 *
 * 用法: node polish-story.js <card_id_or_dir>
 */
const fs = require('fs');
const path = require('path');
const dshHome = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const tavernCards = () => path.join(dshHome(), 'tavern', 'cards')


const os = require('os');
const BASE_DIR = tavernCards();
const CARD_ID = process.argv[2];
if (!CARD_ID) { console.error('用法: node polish-story.js <card_id_or_dir>'); process.exit(1); }
const cardDir = path.isAbsolute(CARD_ID)
  ? CARD_ID
  : path.join(BASE_DIR, fs.readdirSync(BASE_DIR).find(d => d.startsWith(CARD_ID) || d.includes(CARD_ID)) || '');
if (!fs.existsSync(cardDir)) { console.error(`找不到卡目录: ${CARD_ID}`); process.exit(1); }

const storyFile = path.join(cardDir, 'story.md');
const stateFile = path.join(cardDir, 'state.json');
const logFile = path.join(cardDir, 'analysis-log.md');
const storyMd = fs.readFileSync(storyFile, 'utf8');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

const section = (md, name) => {
  const m = md.match(new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |\\Z)`, 'm'));
  return m ? m[1].trim() : '';
};

const KEY = fs.readFileSync(path.join(dshHome(), '.credentials.yaml'), 'utf8')
  .match(/^DEEPSEEK_API_KEY:\s*(.+)$/m)?.[1].trim().replace(/["']/g, '');
if (!KEY) { console.error('找不到 DEEPSEEK_API_KEY'); process.exit(1); }

async function callJSON(system, user) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 2500, temperature: 0.6, stream: false, // 精修允许推理，换取归纳质量
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content ?? '').trim();
  try { return JSON.parse(text.replace(/^```json|```$/g, '').trim()); }
  catch (e) { throw new Error(`返回不是合法 JSON: ${text.slice(0, 200)}`); }
}

async function main() {
  const idDesc = section(storyMd, '身份档案');
  const scenario = section(storyMd, '场景与开端');
  const opening = section(storyMd, '开场白');
  const examples = section(storyMd, '范例对话') || '';
  const hasExamples = examples.length > 200;

  const system = '你是角色卡精修师。基于给定的角色原文，归纳出结构化角色档案。要求：\n' +
    '1. 所有归纳必须源于给出的原文证据，禁止脑补原文没有的设定。\n' +
    '2. personality 与 speech_style 都是**字符串数组**，每个元素一条，**各至少 4 条、最多 6 条**；原文已列出的性格特质直接提炼整合。\n' +
    '3. speech_style 每条是一条可执行的说话风格规则（口吻/称呼/修辞/句式/动作描写习惯等）。\n' +
    '4. 若没有范例对话，speech_style 基于描述与开场白推断，每条以（推断）结尾。\n' +
    '5. state_init 从原文推断：location（场景地点英文键，如 home/city/school/castle）、scene（剧情阶段）、mood（初始情绪词）、relationship（初始关系档位）、notes（≤50 字初始情境备注）。\n' +
    '6. 禁止输出 "unknown" 等占位词：提取不到具体值时用中性默认（location:"home", scene:"初遇", mood:"neutral", relationship:"stranger", notes:""）。\n' +
    '只输出 JSON：{"personality": ["..."], "speech_style": ["..."], "state_init": {"location": "...", "scene": "...", "mood": "...", "relationship": "...", "notes": "..."}}';

  const user = `【身份档案】\n${idDesc}\n\n【场景与开端】\n${scenario}\n\n【开场白】\n${opening}\n\n【范例对话】\n${hasExamples ? examples.slice(0, 3000) : '(无)'}`;

  console.log(`正在为 ${path.basename(cardDir)} 归纳性格/说话风格…`);
  let out = await callJSON(system, user);

  // 补足重试：条目不足 4 时追加一轮扩充（仍须基于原文）
  const count = v => (Array.isArray(v) ? v.length : typeof v === 'string' ? v.split(/\n+/).filter(Boolean).length : 0);
  if (count(out.personality) < 4 || count(out.speech_style) < 4) {
    console.log('  条目不足 4 条，发起补足…');
    const fill = await callJSON(system,
      user + `\n\n（上一次你的归纳不够完整：personality ${count(out.personality)} 条、speech_style ${count(out.speech_style)} 条。请各自补足到至少 4 条，合并已有内容，输出完整 JSON。）`);
    for (const k of ['personality', 'speech_style']) {
      const a = Array.isArray(out[k]) ? out[k] : [];
      const b = Array.isArray(fill[k]) ? fill[k] : [];
      const merged = [...a];
      for (const item of b) if (!merged.includes(item)) merged.push(item);
      out[k] = merged.slice(0, 6);
    }
    if (!out.state_init || Object.keys(out.state_init).length === 0) out.state_init = fill.state_init;
  }

  // 性格专项补全：仍不足 4 条时，单独一轮针对原文 Personality 段提炼完整性格条目
  if (count(out.personality) < 4) {
    console.log('  性格仍不足 4 条，专项补全…');
    const fix = await callJSON(
      '你是角色卡精修师。只做一件事：把角色的性格提炼成字符串数组。要求：\n' +
      '1. 每条用完整的陈述句（如"冷漠疏离，戒备心强，尤其不信任男性"），禁止只给单词。\n' +
      '2. 至少 4 条、最多 6 条；覆盖原文 Personality/描述中列出的全部要点。\n' +
      '3. 严格基于原文，不新增设定。\n只输出 JSON：{"personality": ["..."]}',
      `【身份档案】\n${idDesc}`);
    const fixed = Array.isArray(fix.personality) ? fix.personality : [];
    const merged = [...(Array.isArray(out.personality) ? out.personality : []), ...fixed].filter(Boolean);
    out.personality = [...new Set(merged)].slice(0, 6);
  }

  const coerce = v => Array.isArray(v)
    ? v.map((s, i) => (String(s).trim().startsWith(`${i + 1}.`) ? String(s).trim() : `${i + 1}. ${String(s).trim()}`)).join('\n')
    : (typeof v === 'string' ? v : '');
  const personality = coerce(out.personality);
  const speechStyle = coerce(out.speech_style);

  // ---- 落盘：插入/更新小节（原文小节不动；基于行的插入，绕开正则多行陷阱）----
  let md = storyMd;

  const insertAfter = (afterHeader, block) => {
    if (md.includes(`## ${block.header}`)) return true; // 幂等
    const lines = md.split('\n');
    const start = lines.findIndex(l => l.startsWith(`## ${afterHeader}`));
    if (start < 0) return false;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) { end = i; break; }
    }
    lines.splice(end, 0, '', `## ${block.header}`, ...block.body.split('\n'));
    md = lines.join('\n');
    return true;
  };

  insertAfter('身份档案', { header: '性格', body: personality });
  insertAfter('性格', { header: '说话风格', body: speechStyle });

  // 状态说明模板（追加到尾部，幂等）
  const stateDoc = `## 状态说明

state.json 是显式的剧情状态机，每轮回复后必须按剧情增量更新（只改变化的键，不得超过 150 token）：

| 键 | 含义 | 取值范围 |
|---|---|---|
| \`affection\` | 主角对用户的感情态度 | -10（敌视）~ 10（珍视），初始 0 |
| \`mood\` | 当前情绪 | 情绪词 |
| \`location\` | 当前场景位置 | 场景键 |
| \`relationship\` | 关系档位 | 关系词 |
| \`flags\` | 剧情旗标 | 对象 |
| \`scene\` | 剧情阶段 | 阶段名 |
| \`notes\` | 自由备注 | ≤100 字 |

更新原则：只写剧情里**已发生**的变化；\`affection\` 与 \`flags\` 严格由对话内容驱动，不许凭空加分。`;
  if (!md.includes('## 状态说明')) md += `\n${stateDoc}\n`;

  fs.writeFileSync(storyFile, md);

  // ---- state.json 精修（保留已有人工/剧情值之外的初始化字段）----
  const init = out.state_init || {};
  const good = v => v && typeof v === 'string' && v.trim() && !/^unknown$/i.test(v.trim());
  const sceneIsDefault = /^(开场|开局场景)$/.test(state.scene);
  if (sceneIsDefault && good(init.scene)) state.scene = init.scene;
  if (good(init.location)) state.location = init.location;
  if (good(init.mood)) state.mood = init.mood;
  if (good(init.relationship)) state.relationship = init.relationship;
  if (!state.notes && good(init.notes)) state.notes = init.notes;
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  // ---- analysis-log 记录 ----
  const liCount = s => s.split('\n').filter(l => /^\s*(\d+\.|-)\s/.test(l.trim())).length;
  const entry = `\n## 模型精修步骤（polish-story.js）

- [x] 「性格」：${hasExamples ? '基于描述+开场白+范例对话' : '基于描述+开场白（无范例）'}归纳，${liCount(personality)} 条。
- [x] 「说话风格」：${hasExamples ? '有范例对话，规则为归纳' : '无范例对话，规则标注（推断）'}，${liCount(speechStyle)} 条。
- [x] state.json 初始化精修：location=${state.location}, scene=${state.scene}, mood=${state.mood}, relationship=${state.relationship}。
- 原文小节零改动。`;
  fs.appendFileSync(logFile, entry);

  console.log('✅ 精修完成');
  console.log(`   location=${state.location} scene=${state.scene} mood=${state.mood} relationship=${state.relationship}`);
  console.log(`   story.md 章节: ${md.match(/^## /gm).join(' | ')}`);
}

main().catch(e => { console.error(`失败: ${e.message}`); process.exit(1); });
