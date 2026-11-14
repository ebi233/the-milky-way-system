#!/usr/bin/env node
/**
 * parse-card.js — card-analyst 核心解析管线（独立版，供验证与后续 agent 复用）
 *
 * 输入: 角色卡文件路径（PNG 或 JSON）
 * 输出: cards/<card_id>/{meta.json, story.md, state.json, analysis-log.md}
 *
 * 用法:
 *   node parse-card.js <卡文件路径> [输出目录]
 *   node parse-card.js --selftest   # 构造一个带 chara chunk 的合成 PNG 自检读取
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const dshHome = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const tavernCards = () => path.join(dshHome(), 'tavern', 'cards')

const zlib = require('zlib');
const crypto = require('crypto');

// ---------------------------------------------------------------- PNG 管线
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 遍历 PNG chunk，返回 { name, data }[]（跳过签名与 CRC 校验） */
function pngChunks(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG 文件（签名不符）');
  const chunks = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const name = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    chunks.push({ name, data });
    off += 12 + len;
  }
  return chunks;
}

/** 从 tEXt chunk data 解出 [keyword, text]（PNG 规范：keyword \0 text，Latin-1） */
function decodeTextChunk(data) {
  const nul = data.indexOf(0);
  if (nul < 0) return [data.toString('latin1'), ''];
  return [data.toString('latin1', 0, nul), data.toString('latin1', nul + 1)];
}

/** 读取 PNG 中的角色卡 JSON：ccv3 优先，chara 次之 */
function readCardFromPng(buf) {
  const texts = pngChunks(buf)
    .filter(c => c.name === 'tEXt')
    .map(c => decodeTextChunk(c.data));
  const pick = texts.find(([k]) => k.toLowerCase() === 'ccv3') || texts.find(([k]) => k.toLowerCase() === 'chara');
  if (!pick) throw new Error('PNG 中没有角色卡元数据（无 chara/ccv3 tEXt chunk）');
  let json;
  try {
    json = Buffer.from(pick[1], 'base64').toString('utf8');
  } catch {
    json = pick[1]; // 容错：非 base64 时直接当 utf8
  }
  try {
    return JSON.parse(json);
  } catch (e) {
    throw new Error(`PNG 元数据不是合法 JSON: ${e.message}`);
  }
}

// ---------------------------------------------------------------- 规范化
/** 判定 V1/V2/V3 并归一化为统一内部结构 */
function normalizeCard(card) {
  const v1 = v => (typeof v === 'string' ? v : '');
  const arr = a => (Array.isArray(a) ? a : typeof a === 'string' ? [a] : []);
  let spec = 'unknown';

  if (card.spec === 'chara_card_v3') {
    spec = 'v3';
    const d = card.data || {};
    const system = d.system || {};
    return {
      spec,
      name: v1(d.name || card.name),
      description: v1(d.description || card.description || ''),
      personality: v1(d.personality || card.personality || ''),
      scenario: v1(d.scenario || card.scenario || ''),
      first_mes: v1(d.first_mes || card.first_mes || ''),
      mes_example: v1(d.mes_example || card.mes_example || ''),
      creator_notes: v1(d.creator_notes || d.creatorNotes || card.creatorcomment || ''),
      system_prompt: v1(system.prompt || d.system_prompt || ''),
      post_history_instructions: v1(system.post_history_instructions || d.post_history_instructions || ''),
      tags: arr(d.tags || card.tags),
      creator: v1(d.creator || card.creator || ''),
      character_version: v1(d.character_version || card.character_version || ''),
      alternate_greetings: arr(d.alternate_greetings || card.alternate_greetings),
      character_book: d.character_book || null,
      extensions: d.extensions || card.extensions || {},
    };
  }

  if (card.spec === 'chara_card_v2') {
    spec = 'v2';
    const d = card.data || {};
    return {
      spec,
      name: v1(d.name || card.name),
      description: v1(d.description || card.description || ''),
      personality: v1(d.personality || card.personality || ''),
      scenario: v1(d.scenario || card.scenario || ''),
      first_mes: v1(d.first_mes || card.first_mes || ''),
      mes_example: v1(d.mes_example || card.mes_example || ''),
      creator_notes: v1(d.creator_notes || card.creatorcomment || ''),
      system_prompt: v1(d.system_prompt || ''),
      post_history_instructions: v1(d.post_history_instructions || ''),
      tags: arr(d.tags || card.tags),
      creator: v1(d.creator || card.creator || ''),
      character_version: v1(d.character_version || card.character_version || ''),
      alternate_greetings: arr(d.alternate_greetings),
      character_book: d.character_book || null,
      extensions: d.extensions || {},
    };
  }

  // V1: 扁平
  const required = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];
  if (required.every(f => Object.prototype.hasOwnProperty.call(card, f))) {
    spec = 'v1';
    return {
      spec,
      name: v1(card.name),
      description: v1(card.description),
      personality: v1(card.personality),
      scenario: v1(card.scenario),
      first_mes: v1(card.first_mes),
      mes_example: v1(card.mes_example),
      creator_notes: v1(card.creatorcomment || ''),
      system_prompt: '',
      post_history_instructions: '',
      tags: arr(card.tags),
      creator: v1(card.creator || ''),
      character_version: v1(card.character_version || ''),
      alternate_greetings: arr(card.alternate_greetings),
      character_book: card.character_book || card.data?.character_book || null,
      extensions: card.extensions || card.data?.extensions || {},
    };
  }

  throw new Error(`无法识别的角色卡格式（非 V1/V2/V3）：顶层 keys = ${Object.keys(card).join(', ')}`);
}

// ---------------------------------------------------------------- 世界书扁平化
function flattenBook(book) {
  if (!book || !Array.isArray(book.entries)) return '';
  const entries = book.entries
    .filter(e => e.enabled !== false)
    .sort((a, b) => (a.insertion_order ?? 0) - (b.insertion_order ?? 0));
  return entries.map(e => {
    const head = e.comment || (Array.isArray(e.keys) ? e.keys.join('、') : '');
    return head ? `### ${head}\n${e.content}` : e.content;
  }).join('\n\n');
}

// ---------------------------------------------------------------- 状态初始化（规则版）
function initState(norm) {
  const state = {
    schema: 1,
    affection: 0,
    mood: 'neutral',
    location: 'unknown',
    relationship: 'stranger',
    flags: {},
    scene: '开场',
    notes: '',
  };
  // 从 description/scenario/first_mes 里粗提场景地点关键词（v0 规则版；agent 版由模型细化）
  // 现代卡 personality/scenario 常为空，人设全在 description，因此必须一并扫描
  const hay = (norm.description + ' ' + norm.scenario + ' ' + norm.first_mes).toLowerCase();
  const locs = {
    castle: ['castle', 'palace', 'empire', 'kingdom', '帝国', '王宫', '城堡', '皇宫'],
    school: ['school', 'academy', 'campus', '学院', '学校', '校园'],
    inn: ['inn', 'tavern', 'bar', '酒馆', '酒吧'],
    city: ['city', 'town', 'street', '城', '镇'],
    home: ['home', 'house', 'apartment', '家', '公寓'],
  };
  for (const [k, words] of Object.entries(locs)) {
    if (words.some(w => hay.includes(w))) { state.location = k; break; }
  }
  if (norm.scenario) state.scene = '开局场景';
  return state;
}

// ---------------------------------------------------------------- 产出物
function genStoryMd(norm, bookText) {
  const L = [];
  L.push(`# ${norm.name}（角色卡）\n`);
  L.push(`## 身份档案`);
  L.push(norm.description || '（卡未提供 description）');
  L.push('');
  if (norm.personality) {
    L.push(`## 性格`);
    L.push(norm.personality);
    L.push('');
  }
  if (norm.scenario) {
    L.push(`## 场景与开端`);
    L.push(norm.scenario);
    L.push('');
  }
  if (norm.first_mes) {
    L.push(`## 开场白`);
    L.push(norm.first_mes);
    L.push('');
  }
  if (bookText) {
    L.push(`## 世界观与背景`);
    L.push(bookText);
    L.push('');
  }
  if (norm.mes_example) {
    L.push(`## 范例对话`);
    L.push('```');
    L.push(norm.mes_example);
    L.push('```');
    L.push('');
  }
  if (norm.system_prompt) {
    L.push(`## 创作约束`);
    L.push(norm.system_prompt);
    L.push('');
  }
  if (norm.post_history_instructions) {
    L.push(`## 每轮后检查`);
    L.push(norm.post_history_instructions);
    L.push('');
  }
  return L.join('\n');
}

function genAnalysisLog(norm, card, sourceFile) {
  const L = [];
  L.push(`# 解析日志：${norm.name}`);
  L.push('');
  L.push(`- 来源文件：\`${sourceFile}\``);
  L.push(`- 卡格式：${norm.spec}${norm.character_version ? `（character_version: ${norm.character_version}）` : ''}`);
  L.push(`- 作者：${norm.creator || '未知'}`);
  L.push(`- 标签：${norm.tags.join(', ') || '无'}`);
  L.push('');
  const checks = [
    ['name', '角色名'],
    ['description', '身份档案'],
    ['personality', '性格'],
    ['scenario', '场景'],
    ['first_mes', '开场白'],
    ['mes_example', '范例对话'],
    ['creator_notes', '作者注'],
    ['system_prompt', '系统提示'],
    ['post_history_instructions', '历史后指令'],
  ];
  L.push(`| 字段 | 状态 | 规模 |`);
  L.push(`|---|---|---|`);
  for (const [k, label] of checks) {
    const v = norm[k] || '';
    L.push(`| ${label} | ${v ? '✅' : '⚠️ 缺失'} | ${v.length} 字符 |`);
  }
  L.push(`| 开场白备选（alternate_greetings） | ${norm.alternate_greetings.length ? `✅ ${norm.alternate_greetings.length} 条` : '—'} | — |`);
  L.push(`| 卡内世界书 | ${norm.character_book ? `✅ ${norm.character_book.entries?.length ?? 0} 条` : '—'} | — |`);
  L.push('');
  if (!norm.personality && norm.description) L.push(`> ⚠️ 卡未提供 personality 字段（现代卡常见），性格由 description 承载。`);
  if (!norm.mes_example) L.push(`> ⚠️ 无 mes_example：说话风格只能由模型从 description/first_mes 归纳，风格保真度下降。`);
  if (!norm.system_prompt) L.push(`> ℹ️ 卡未覆盖 system_prompt，使用默认 main 提示。`);
  return L.join('\n');
}

// ---------------------------------------------------------------- 主流程
function processCard(srcFile, outRoot) {
  const raw = fs.readFileSync(srcFile);
  const isPng = raw.subarray(0, 8).equals(PNG_SIG);
  const card = isPng ? readCardFromPng(raw) : JSON.parse(raw.toString('utf8'));
  const norm = normalizeCard(card);
  const id = `${norm.name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'card'}-${crypto.createHash('md5').update(norm.name).digest('hex').slice(0, 6)}`;
  const outDir = path.join(outRoot || '.', id);
  fs.mkdirSync(outDir, { recursive: true });

  const bookText = flattenBook(norm.character_book);
  const state = initState(norm);

  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({
    source_file: srcFile, source_format: isPng ? 'png' : 'json',
    card: { name: norm.name, spec: norm.spec, character_version: norm.character_version, creator: norm.creator, tags: norm.tags, raw_json: card },
  }, null, 2));
  fs.writeFileSync(path.join(outDir, 'story.md'), genStoryMd(norm, bookText));
  fs.writeFileSync(path.join(outDir, 'state.json'), JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(outDir, 'analysis-log.md'), genAnalysisLog(norm, card, srcFile));

  return { id, outDir, norm, isPng, bookEntries: norm.character_book?.entries?.length ?? 0 };
}

// ---------------------------------------------------------------- PNG 自检
function selfTest() {
  // 构造 1x1 RGBA PNG + chara tEXt chunk
  const sig = PNG_SIG;
  function chunk(name, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const type = Buffer.from(name, 'latin1');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([len, type, data, crc]);
  }
  function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = (crc ^ buf[i]) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6; // RGBA
  const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255])); // filter 0 + 1px RGBA
  const testCard = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '自检卡', description: '合成 PNG 测试', personality: '', scenario: '', first_mes: '你好', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: ['test'], creator: 'selftest', character_version: '1.0', extensions: {} } };
  const b64 = Buffer.from(JSON.stringify(testCard), 'utf8').toString('base64');
  const tEXt = chunk('tEXt', Buffer.concat([Buffer.from('chara', 'latin1'), Buffer.from([0]), Buffer.from(b64, 'latin1')]));
  const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), tEXt, chunk('IEND', Buffer.alloc(0))]);

  const read = readCardFromPng(png);
  const ok = read.data.name === '自检卡' && read.data.description === '合成 PNG 测试';
  console.log(`[selftest] PNG tEXt 提取与 base64 解码: ${ok ? '✅ 通过' : '❌ 失败'}`);
  if (!ok) console.log(JSON.stringify(read));
}

// ----------------------------------------------------------------
const arg = process.argv[2];
if (arg === '--selftest') { selfTest(); process.exit(0); }
if (!arg) { console.error('用法: node parse-card.js <卡文件> [输出目录] | --selftest'); process.exit(1); }

const r = processCard(arg, process.argv[3] || tavernCards());
console.log(`✅ ${path.basename(arg)}`);
console.log(`   格式: ${r.isPng ? 'PNG' : 'JSON'} → ${r.norm.spec} | 角色: ${r.norm.name} | 世界书: ${r.bookEntries} 条`);
console.log(`   输出: ${r.outDir}`);
