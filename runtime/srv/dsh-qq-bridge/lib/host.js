import {requestChannel} from './channel-transport.mjs'
import {installPrivateChat} from './private-chat.mjs'
import {purpose,purposeOverview} from './purpose-engine.mjs'
import {purposeReceipts} from './purpose-receipts.mjs'
import {createDocuments} from './documents.mjs'
import {transcribeVoice as 安全转写语音} from './voice.mjs'
import {admitIncomingImages} from '../../dsh-qq-ext/dsh-vision/ingress.mjs'
import {createOwnerWarmup} from './owner-warmup.mjs'
import {privateProactive} from './private-proactive.mjs'
import {imageDeliveryReceipts} from './image-delivery-receipts.mjs'
import {cleanOutgoingText,splitReplyBubbles} from './output-control.mjs'
import {emptyReply,appendReply,registerSupplementReceiver,createDeliveryQueue} from './reply-turns.mjs'
import {privateActivity} from './proactive-context.mjs'
import {qqHealth,readChannelHealth} from './channel-health.mjs'
import {createInputEvidence,groupReplyAllowed,callsPaopao,decideGroupReply,recordGroupOutput} from './group-reply-policy.mjs'
import {flushBefore,renderGroupBurst} from './conversation-batch.mjs'
import {readObject,writeObject,singleFlight,verifyManaged} from './runtime-state.mjs'
import {createGroupOnboarding} from './group-onboarding.mjs'
import {createGroupProactive} from './group-proactive.mjs'
import {mergeGuestBindings,allocateGuests,saveGuests} from './guest-routing.mjs'
import { makeSelfGroupCard } from './self-group-card.mjs'
import { validateBindings, sealGroupBindings, assertTrustedGroup } from '../../dsh-qq-ext/dsh-long-memory/lib/group-privacy.mjs'
// DSH「通到 QQ」· 宿主半边
//
// 这一半只做一件事（先只做 DSH → QQ）：
//   伙伴在「目标会话」里说完一句话（一整轮的最后一句），就自动把它发到 QQ（私聊 / 群）。
//   发 QQ 走 NapCat 的 OneBot HTTP 接口（127.0.0.1:3000），走标准的 OneBot 11 HTTP。
//
// 反过来（QQ → DSH）是下一半，放到另一个插件/进程里做，不在这里混。
//
// ⚠ 安全默认：总开关 = false、试运行 = true —— 不手动打开，一句都不会真的发到 QQ。

import { readFileSync, writeFileSync, mkdirSync, existsSync, createWriteStream, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createSelfUpdate } from './selfupdate.mjs'

export const name = 'qq-bridge'

/** 需要宿主提供：webServer（路由）+ sessions/sessionTitle（目标会话清单 + 标题）+ agents（followup）+ timer（轮询收消息）+ attachments（图片）。 */
export const inject = ['agents', 'sessions', 'sessionController', 'sessionTitle', 'webServer', 'timer', 'workspaceRegistry', 'attachments', 'tools', 'llm']

// ---------- 常量 ----------

const 目录 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 配置文件 = join(目录, 'qq-bridge-config.json')
const 路由前缀 = '/dsh-qq-bridge'
const 日志上限 = 60

const 默认配置 = {
  总开关: false, // 关着 = 一句都不发（安全默认）
  试运行: true, // 开着 = 只记账、不真发到 QQ
  目标会话: '', // ⚠️ 老字段（= 私聊会话）。还认，读的时候会搬进「私聊会话」
  私聊会话: '', // ⭐ QQ 私聊那一路进哪一间（2026-10-25 拆开）
  群会话: '', //   ⭐ QQ 群里那一路进哪一间（可以留空 = 不看群）
  私聊QQ: '', // 发到哪个私聊（QQ 号，字符串）
  群号: '', // 发到哪个群（可空）
  转私聊: true,
  转群: false,
  NapCat: 'http://127.0.0.1:3000', // OneBot HTTP 接口
  令牌: '', // ⭐ access_token（2026-10-25）：NapCat / SnowLuma 开了鉴权就填这里，留空 = 不鉴权
  // ⭐ 2026-10-22：图片两个方向
  收图: true, // QQ → DSH：她发的图片也转进来
  收图最多: 4, // 一条消息最多转几张
  发图: true, // DSH → QQ：伙伴发的图片也发过去
  图上限MB: 5, // 单张最大多少 MB（两个方向共用）
  图片根目录: '', // 正文里 `![名字](相对路径)` 按哪个目录去找（留空 = 自动猜）
  称呼: '对方', // ⭐ 私聊时怎么称呼跟它说话的那个人（写进转给它的文案里，比如「小明发来了图片」）
  回复门槛: false, // ⚠ 已废弃（2026-10-25）：门槛改成「按绑定行走」——老配置里是 true 的会在迁移时变成那一行的门槛
  // ⭐ 0.7.0（用户 GAME-66 的建议，issue #2）出站两个闸，默认都关
  只发标记内: false, // 开着 = 只发正文里 [QQ]…[/QQ] 那一段（块外的解释/路径/思考留在本地）
  只回QQ唤醒: false, // 开着 = 只有「这一轮是被 QQ 消息叫醒的」才发（你在 DSH 里自己聊的不推到手机）
  // ⭐ 0.8.0：语音转写（QQ 语音条 → 文字）。插件自己不带模型，只负责把音频交给「你指定的命令」。
  语音转写: false,
  转写命令: '', // 模板，里面必须带 {file}；例如：python D:sr.py "{file}"
  语音模型目录: '', // 语音模型放哪（SenseVoice 的 model.int8.onnx + tokens.txt 所在目录）
  转写超时秒: 60,
  补投窗口分: 10, // 会话关着期间攒下的消息，超过这么多分钟就不再补投
  // ⭐ 2026-10-25（QQ 桥用户反馈「一次回一堆消息」）：长回复按空行拆成几条连发，以前是写死的。
  长回复拆段: true, // 关掉 = 一整段只发一条消息（不再刷屏）
  拆段间隔毫秒: 450, // 每段之间隔多久（太短像刷屏，太长像卡住）
  // ⭐ 2026-10-25：门槛判定「不接」时，要不要**真把这一轮停掉**。
  //   · 关（默认）：不停轮，只把这轮的「出站」掐掉 —— 界面干净，但模型会把这轮想完（费一点 token）
  //   · 开：调用 agent.cancel() 停轮 —— 这才是真的「停止思考」，代价是界面上会出现
  //        `Error: tool call aborted`（那是停轮的**表现**，不是故障），有的宿主还会「重试模型请求」
  门槛真停轮: false,
  // ⭐⭐ 2026-10-25：绑定列表 —— 一行 = 一个聊天（私聊/群）→ 一间 DSH 会话
  //   { 类型: '私聊' | '群', 号码: 'QQ号或群号', 会话: 'session-…', 称呼: '小明', 门槛: false }
  绑定: [],
 主人号码: '', // ⭐ 主人的 QQ 号：这一行的会话算「家人」，其它绑定都算「客人」
  群称呼: '群里的人', // ⭐ 群聊时怎么称呼（群里不止一个人，一般别填某个人的名字）
  // ⭐ 1.0.1（issue #6）：一次 QQ 消息触发的**整个回复过程**都算「QQ 起的头」。
  //   第一轮发完之后，还留这么长的「尾巴」——尾巴内的后续轮次也往外发。
  //   0 = 关掉尾巴（回到老行为：只有紧跟的那一轮能发）。
  唤醒尾巴秒: 90,
  // ⭐ 0.9.9：群里**只收点了名的**（@ 你 / 引用你）。开了这个就把群里所有人的话都转进来，
  //    交给「门槛」去判断要不要接 —— 更自然，但更贵、也更吵。
  群里听所有人: false,
  // ⭐ 1.0.2（别处报的「发一串图，DSH 一张一张回」）：连着发的几条**攒成一条**再转进来。
  //   · 0 = 不攒（来一条转一条，跟以前一样）
  //   · >0 = 同一个人在这段时间内连着发的，合成一条（私聊、群都管用）
  //   实现上是「等一小会儿再收」：最后一条没过去这么久，就先不消费，下一跳连新的那条一起收。
  //   ⚠ 别开大：一轮拉历史里本来就能看到「已经发完的那一串」，这里只兜「正好撞上轮询」的那一下。
  合并窗口秒: 1,
  // 最多攒多久（秒）：有人一直发个不停，到点也得先转进来，不能无限等
  合并最多秒: 20,
  // ⭐ 1.0.2：多久去 NapCat 拉一次新消息（毫秒）。原来写死 4 秒，单条消息最坏要等 4 秒才进来。
  轮询间隔毫秒: 2000,
}

/** 包根目录（用它读自己包里的东西，比如 tools/asr_cli.py） */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 版本从 package.json 读。 */
const 版本 = (() => {
  try {
    const p = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
    return String(p.version || '?')
  } catch (error) {
    return '?'
  }
})()

/** 跑一条外部命令（异步、带超时、拿 stdout）。
 *  ⭐ 语音转写用：插件自己**不带 ASR 模型**，只负责「把音频文件交给用户指定的命令，拿回文字」。
 *  这样本机 whisper / SenseVoice / 云端 API 都能接，插件也不会因为塞模型变成几百 MB。 */
function 跑命令(模板, 文件, 超时秒) {
  return new Promise((resolve) => {
    const 命令 = String(模板 || '').replace(/\{file\}/g, 文件)
    let 出 = ''
    let 错 = ''
    let 收过 = false
    const 收 = (v) => { if (收过) return; 收过 = true; resolve(v) }
    let 子 = null
    try {
      子 = spawn(命令, {
        shell: true, windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      })
    } catch (error) {
      return 收({ ok: false, 错: String((error && error.message) || error) })
    }
    const 定时 = setTimeout(() => {
      try { 子.kill() } catch (error) {}
      收({ ok: false, 错: '超时（' + 超时秒 + ' 秒）' })
    }, Math.max(5, Number(超时秒) || 60) * 1000)
    子.stdout.on('data', (c) => { 出 += c })
    子.stderr.on('data', (c) => { 错 += c })
    子.on('error', (error) => { clearTimeout(定时); 收({ ok: false, 错: String((error && error.message) || error) }) })
    子.on('close', (码) => {
      clearTimeout(定时)
      收({ ok: 码 === 0, 文字: 出.trim(), 错: (错.trim() || ('退出码 ' + 码)) })
    })
  })
}

/** 把「语音段」里的东西落成本地文件（QQ 给的有三种形态：http 链接 / base64:// / 本地文件名）
 *  ⚠️ 2026-10-25 修（她实测报的）：以前直接把 `file` 丢给转写命令 —— 那个值经常是
 *     `https://multimedia.nt.qq.com.cn/download?appid=...` 这种**网络地址**，
 *     命令当然找不到文件，就报「找不到音频文件」。现在先下载/解码到本地再交给它。 */
async function 语音落文件(段, 拉任意, 家目录, 名) {
  const d = (段 && 段.data) || {}
  const 原 = String(d.file || d.url || '')
  const 直链 = String(d.url || '') || (/^https?:/i.test(原) ? 原 : '')
  const 落盘 = (字节, 扩展) => {
    try {
      const 目录 = join(家目录, 'audio')
      mkdirSync(目录, { recursive: true })
      const 文件 = join(目录, String(名).replace(/[^a-zA-Z0-9_-]/g, '') + '.' + 扩展)
      writeFileSync(文件, 字节)
      return 文件
    } catch (error) { return '' }
  }
  const 从地址取扩展 = (u) => {
    const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(String(u || ''))
    const e = m ? m[1].toLowerCase() : ''
    return ['wav', 'mp3', 'amr', 'silk', 'ogg', 'm4a', 'flac'].includes(e) ? e : 'amr'
  }
  // ① 先问后端：get_record 能直接给 wav（它自己会解 silk）—— 这是最省事的一条路
  if (原) {
    try {
      const r = await 拉任意('get_record', { file: 原, out_format: 'wav' })
      if (r) {
        const 本地 = r.file || r.path
        if (本地 && existsSync(String(本地))) return String(本地)
        if (r.base64) {
          try {
            const f = 落盘(Buffer.from(String(r.base64).replace(/^data:[^,]*,/, ''), 'base64'), 'wav')
            if (f) return f
          } catch (error) {}
        }
      }
    } catch (error) {}
  }
  // ② 网络地址 → 下载
  const 拿地址 = 直链 || (/^https?:/i.test(原) ? 原 : '')
  if (拿地址) {
    try {
      const r = await fetch(拿地址)
      if (r && r.ok) {
        const 字节 = Buffer.from(await r.arrayBuffer())
        const f = 落盘(字节, 从地址取扩展(拿地址))
        if (f) return f
      }
    } catch (error) {}
  }
  // ③ base64:// 或本来就是本地文件
  if (原.startsWith('base64://')) {
    try {
      const f = 落盘(Buffer.from(原.slice('base64://'.length), 'base64'), 'amr')
      if (f) return f
    } catch (error) {}
  }
  if (原 && existsSync(原)) return 原
  return ''
}

/** 不是 wav 就转成 16k 单声道 wav（用 ffmpeg；找不到就原样交给命令，让命令自己想办法） */
async function 转成wav(路径, ffmpeg, 家目录, 名) {
  if (!路径 || /\.wav$/i.test(路径)) return 路径
  if (!ffmpeg) return 路径
  try {
    const 目录 = join(家目录, 'audio')
    mkdirSync(目录, { recursive: true })
    const 出 = join(目录, String(名).replace(/[^a-zA-Z0-9_-]/g, '') + '.wav')
    const 结果 = await new Promise((resolve) => {
      let 子 = null
      try {
        子 = spawn(ffmpeg, ['-y', '-i', 路径, '-ar', '16000', '-ac', '1', 出], { windowsHide: true })
      } catch (error) { return resolve(false) }
      子.on('error', () => resolve(false))
      子.on('close', (码) => resolve(码 === 0 && existsSync(出)))
    })
    return 结果 ? 出 : 路径
  } catch (error) { return 路径 }
}

/** 一条 QQ 语音 → 文字。插件只做三件事：拿到音频 → 交给命令 → 拿回文字。
 *  ⚠️ 没配命令、或者没开开关，就退化成 `[语音]` 三个字（跟以前一样）。 */
async function 转写语音(段, 拉任意, 配置, 选项 = {}) {
  return 安全转写语音(段, 拉任意, 配置, { home: 选项.家目录 || 目录 })
}

/** 找 ffmpeg：环境变量 → PATH → 装依赖时随手装的那份 imageio-ffmpeg。
 *  语音要转成 wav 才能喂给识别命令，没有 ffmpeg 就只能把原始文件交出去。 */
let ffmpeg缓存 = null
async function 找ffmpeg() {
  if (ffmpeg缓存 !== null) return ffmpeg缓存
  const 试 = async (命令, 参数) => {
    try {
      const 码 = await new Promise((resolve) => {
        let 子 = null
        try { 子 = spawn(命令, 参数, { windowsHide: true }) } catch (error) { return resolve(-1) }
        子.on('error', () => resolve(-1))
        子.on('close', (c) => resolve(c === null ? -1 : c))
      })
      return 码 === 0
    } catch (error) { return false }
  }
  if (process.env.FFMPEG && await 试(process.env.FFMPEG, ['-version'])) return (ffmpeg缓存 = process.env.FFMPEG)
  if (await 试('ffmpeg', ['-version'])) return (ffmpeg缓存 = 'ffmpeg')
  // 装依赖时装了 imageio-ffmpeg 的话，它自带一个静态 ffmpeg
  try {
    const 脚本 = 'import imageio_ffmpeg,sys;sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())'
    const r = await 跑命令('"' + ASRpython + '" -c "' + 脚本.replace(/"/g, '\\"') + '"', '', 20)
    if (r && r.ok && r.文字 && existsSync(r.文字)) return (ffmpeg缓存 = r.文字.trim())
  } catch (error) {}
  return (ffmpeg缓存 = '')
}

// ---------- 配置读写 ----------

function 布(值, 兜) {
  if (值 === true || 值 === 'true' || 值 === 1 || 值 === '1') return true
  if (值 === false || 值 === 'false' || 值 === 0 || 值 === '0') return false
  return 兜
}

/** 把「绑定」整成干净的清单：类型只能是私聊/群；号码和会话都要有；
 *  **同一个会话只能绑一条**、**同一个聊天也只能绑一条**（串消息就是从这里来的）。
 *  老配置（只有一个私聊会话 + 一个群会话）会自动变成两行，不用手动搬。 */
function 规整绑定(raw, 混, 字, 布) {
  const 出 = []
  const 见会话 = new Set()
  const 见聊天 = new Set()
  const 收一条 = (x) => {
    const t = String((x && x.类型) || '').trim()
    const 类型 = t === '私聊' ? '私聊' : (t === '群' ? '群' : '')
    if (!类型) return null
    const 号码 = 字(x && x.号码)
    const 会话 = 字(x && x.会话)
    if (!号码 || !会话) return null
    const 称呼 = (字(x && x.称呼) || (类型 === '群' ? '群里的人' : '对方')).slice(0, 16)
    const 聊天键 = 类型 + ':' + 号码
    if (见聊天.has(聊天键)) return null
    if (见会话.has(会话)) return null          // 一个会话只绑一条
    见聊天.add(聊天键)
    见会话.add(会话)
    return { 类型, 号码, 会话, 称呼, 门槛: 布(x && x.门槛, false) }
  }
  if (Array.isArray(raw)) {
    for (const x of raw.slice(0, 30)) {
      const r = 收一条(x)
      if (r) 出.push(r)
    }
  }
  if (!出.length) {
    // 老配置迁移：私聊会话 / 群会话 → 两行
    const 私会话 = 字(混.私聊会话) || 字(混.目标会话)
    const 私号 = 字(混.私聊QQ)
    const 群会话 = 字(混.群会话)
    const 群号2 = 字(混.群号)
    if (私会话 && 私号) 出.push({ 类型: '私聊', 号码: 私号, 会话: 私会话, 称呼: (字(混.称呼) || '对方').slice(0, 16), 门槛: false })
    if (群会话 && 群号2) 出.push({ 类型: '群', 号码: 群号2, 会话: 群会话, 称呼: (字(混.群称呼) || '群里的人').slice(0, 16), 门槛: false })
  }
  return 出
}

function 归一化(原始) {
  const 是对象 = 原始 && typeof 原始 === 'object' && !Array.isArray(原始)
  const 混 = 是对象 ? { ...默认配置, ...原始 } : { ...默认配置 }
  const 字 = (v) => (typeof v === 'string' ? v.trim() : '')
  const 数 = (v, 兜, 低, 高) => {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n)) return 兜
    return Math.max(低, Math.min(n, 高))
  }
  const 绑定 = 规整绑定(混.绑定, 混, 字, 布)
  // ⭐ 群：groups.json 里登记的群，各自并成一条群绑定
  try {
    const DSH = String(process.env.DSH_HOME || '/srv/dsh-cloud/home')
    const gpf = join(DSH, 'groups.json')
    if (existsSync(gpf)) {
      const g = JSON.parse(readFileSync(gpf, 'utf8'))
      for (const [gid, info] of Object.entries(g || {})) {
        if (!info || !info.session) continue
        if (绑定.some((b) => b.类型 === '群' && String(b.号码) === String(gid))) continue
        绑定.push({
          类型: '群', 号码: String(gid), 会话: String(info.session),
          称呼: '群里的人', 门槛: true,
        })
      }
    }
  } catch (error) {}
  const guestHome = String(process.env.DSH_HOME || '/srv/dsh-cloud/home')
  const mergedGuests = mergeGuestBindings(绑定, readObject(join(guestHome,'guests.json')), 字(混.主人号码))
  绑定.splice(0,绑定.length,...mergedGuests)
  // 老配置迁移：以前是「总开关」带动全部，现在按行走 —— 总开关开过的话，把群那几行补上
  if (布(混.回复门槛, false)) {
    for (const 行 of 绑定) if (行.类型 === '群' && !行.门槛) 行.门槛 = true
  }
  const 私聊行 = 绑定.find((x) => x.类型 === '私聊') || null
  const 群行 = 绑定.find((x) => x.类型 === '群') || null
  return {
    总开关: 布(混.总开关, 默认配置.总开关),
    试运行: 布(混.试运行, 默认配置.试运行),
    // ⭐ 下面这几个老字段现在**从绑定反推**（只留一份真数据，避免两套说法打架）：
    //    私聊会话/群会话 = 绑定里第一条私聊 / 第一条群；老代码还看它们，行为不变。
    私聊会话: 私聊行 ? 私聊行.会话 : '',
    群会话: 群行 ? 群行.会话 : '',
    目标会话: 私聊行 ? 私聊行.会话 : '',
    私聊QQ: 私聊行 ? 私聊行.号码 : 字(混.私聊QQ),
    群号: 群行 ? 群行.号码 : '',
    // ⚠️ 2026-10-25（她报的「群里没收到它的回复」）：这两个老开关界面上已经不显示了，
    //    却还在拦发送 —— 她加了群绑定、但 转群 还是默认 false，于是群里一条都收不到。
    //    现在**有那一行就代表要发**：直接从绑定推。
    转私聊: 绑定.some((b) => b.类型 === '私聊'),
    转群: 绑定.some((b) => b.类型 === '群'),
    NapCat: 字(混.NapCat) || 默认配置.NapCat,
    令牌: 字(混.令牌),
    绑定,
    // ⭐ 新号码自动当客人：从 guest-pool.json 里分一间空房给他（主人号码除外）
    自动接客: 布(混.自动接客, false),
    自动接群: 布(混.自动接群, false),
    群房: 字(混.群房),
    主人号码: 字(混.主人号码),
    收图: 布(混.收图, 默认配置.收图),
    发图: 布(混.发图, 默认配置.发图),
    收图最多: 数(混.收图最多, 默认配置.收图最多, 1, 10),
    图上限MB: 数(混.图上限MB, 默认配置.图上限MB, 1, 30),
    图片根目录: 字(混.图片根目录),
    称呼: (私聊行 ? 私聊行.称呼 : (字(混.称呼) || 默认配置.称呼)),
    // ⚠ 老字段，只用来迁移：以前「总开关 + 每行」两个一起管太难懂，
    //    现在**只认每一行自己的门槛**；老配置里总开关是开的，就给群那几行默认打开。
    回复门槛: 布(混.回复门槛, 默认配置.回复门槛),
    只发标记内: 布(混.只发标记内, 默认配置.只发标记内),
    只回QQ唤醒: 布(混.只回QQ唤醒, 默认配置.只回QQ唤醒),
    语音转写: 布(混.语音转写, 默认配置.语音转写),
    转写命令: 字(混.转写命令).slice(0, 400),
    语音模型目录: 字(混.语音模型目录).slice(0, 400),
    转写超时秒: 数(混.转写超时秒, 默认配置.转写超时秒, 5, 600),
    补投窗口分: 数(混.补投窗口分, 默认配置.补投窗口分, 1, 240),
    长回复拆段: 布(混.长回复拆段, 默认配置.长回复拆段),
    拆段间隔毫秒: 数(混.拆段间隔毫秒, 默认配置.拆段间隔毫秒, 0, 5000),
    门槛真停轮: 布(混.门槛真停轮, 默认配置.门槛真停轮),
    群称呼: (群行 ? 群行.称呼 : (字(混.群称呼) || 默认配置.群称呼)),
    // ⭐ 0.9.9：群里只收「点了名」的；开了这个就收全群（交给门槛判）
    群里听所有人: 布(混.群里听所有人, 默认配置.群里听所有人),
    唤醒尾巴秒: 数(混.唤醒尾巴秒, 默认配置.唤醒尾巴秒, 0, 600),
    // ⭐ 1.0.2：连着发的几条攒成一条（0 = 不攒）
    合并窗口秒: 数(混.合并窗口秒, 默认配置.合并窗口秒, 0, 60),
    合并最多秒: 数(混.合并最多秒, 默认配置.合并最多秒, 3, 300),
    轮询间隔毫秒: 数(混.轮询间隔毫秒, 默认配置.轮询间隔毫秒, 800, 30000),
  }
}

// ---------- 图片小工具（两个方向共用）----------
// ⭐ 2026-10-22 加：QQ 的图片段（OneBot）可能给 http url、本地路径、base64 三种形态，
//    这里统一成字节；大小和类型都在收的时候判，判不了就当 jpeg。

/** 收进来的图存一份到这儿（纯文本模型看不见图，至少能从文字里找到路径） */
/**
 * ⭐ 2026-10-23：会话 id 有两种写法（`xxx` / `session-xxx`）。找agent 两种都认，
 *    但事件过滤、归档判断、设置页高亮这些地方原来是**字面比较** ⇒ 存的是裸 id 时就对不上。
 *    统一用「去掉 session- 前缀」的键来比。
 */
const 会话键 = (v) => {
  const s = String(v == null ? '' : v).trim()
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

const 收图目录 = join(目录, 'qq-bridge-inbox')

/**
 * ⭐ 2026-10-22：DSH 存图时会留一份「归一化副本」（官方文档原话：may be resized or re-encoded），
 *    GIF 到这一步就变成静态 webp 了 —— 所以回发时必须用**我们自己留的原图**。
 *    这张表记「附件 id → 我们存的原图路径」，回发时先查它。
 */
const 收图表 = join(目录, 'qq-bridge-received.json')

function 读收图表() {
  try {
    const j = JSON.parse(readFileSync(收图表, 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch (error) {
    return {}
  }
}

/** 路径统一：去掉两头引号/空格，Windows 下大小写不敏感 */
const 清路径 = (p) => String(p || '').trim().replace(/^["']+|["']+$/g, '').trim()

/**
 * 记「附件 / DSH 那份只读副本 → 我们存的原图」。
 * ⚠ 两个键都要记：伙伴回发时可能用附件 id（附件块），也可能照抄 DSH 给的那条
 *   只读副本路径（正文里的 markdown 图）—— 后者是常见情况，第一次就漏了。
 */
function 记收图(附件id, 副本路径, 原图路径) {
  const 原 = String(原图路径 || '').trim()
  if (!原) return
  const id = String(附件id || '').trim()
  const 副 = 清路径(副本路径)
  if (!id && !副) return
  try {
    const 表 = 读收图表()
    const 记 = { p: 原, t: Date.now() }
    if (id) 表['id:' + id] = 记
    if (副) 表['p:' + 副.toLowerCase()] = 记
    // 只留最近 200 条，别让这个文件无限长
    const 留 = Object.entries(表).sort((a, b) => Number((b[1] && b[1].t) || 0) - Number((a[1] && a[1].t) || 0)).slice(0, 200)
    writeFileSync(收图表, JSON.stringify(Object.fromEntries(留)), 'utf8')
  } catch (error) {}
}

/** 这张图能不能换回原图？键可以是 `id:<附件id>`，也可以是 `p:<副本路径>` */
function 原图路径(键) {
  const k = String(键 || '').trim()
  if (!k) return ''
  const 表 = 读收图表()
  const 记 = 表[k] || 表[k.toLowerCase()] || 表[String(k).replace(/^id:/, '')]
  const p = 记 && typeof 记.p === 'string' ? 记.p : ''
  if (!p) return ''
  try { return existsSync(p) ? p : '' } catch (error) { return '' }
}

const 扩展 = (类) => (类 === 'image/png' ? 'png' : 类 === 'image/gif' ? 'gif' : 类 === 'image/webp' ? 'webp' : 'jpg')

function 看图类(字节) {
  try {
    if (字节[0] === 0x89 && 字节[1] === 0x50) return 'image/png'
    if (字节[0] === 0x47 && 字节[1] === 0x49) return 'image/gif'
    if (字节[0] === 0x52 && 字节[1] === 0x49 && 字节[8] === 0x57) return 'image/webp'
  } catch (error) {}
  return 'image/jpeg'
}

/** 从 OneBot 的图片段里把字节抠出来：url → file(本地/base64://) 依次试 */
async function 取图字节(数据) {
  const d = 数据 || {}
  const url = typeof d.url === 'string' ? d.url.trim() : ''
  if (url) {
    if (url.startsWith('file://')) {
      try { return readFileSync(new URL(url)) } catch (error) {}
    } else if (/^https?:/i.test(url)) {
      try {
        const r = await fetch(url)
        if (r.ok) return Buffer.from(await r.arrayBuffer())
      } catch (error) {}
    }
  }
  const f = typeof d.file === 'string' ? d.file.trim() : ''
  if (f.startsWith('base64://')) {
    try { return Buffer.from(f.slice('base64://'.length), 'base64') } catch (error) {}
  }
  if (f && (f.includes('\\') || f.includes('/'))) {
    try { return readFileSync(f) } catch (error) {}
  }
  return null
}

/** 存一份到收图目录，返回路径（存不下就返回空串，不影响转图） */
function 存一张(名字, 字节, 类) {
  try {
    mkdirSync(收图目录, { recursive: true })
    const p = join(收图目录, `${名字}.${扩展(类)}`)
    writeFileSync(p, 字节)
    return p
  } catch (error) {
    return ''
  }
}

function 读配置() {
  try {
    return 归一化(JSON.parse(readFileSync(配置文件, 'utf8')))
  } catch (error) {
    return 归一化(null)
  }
}

function 写配置(配置) {
  try {
    mkdirSync(目录, { recursive: true })
    writeFileSync(配置文件, JSON.stringify(配置, null, 2), 'utf8')
    return true
  } catch (error) {
    return false
  }
}

// ---------- 纯函数（导出给冒烟测试喂） ----------

/** 从一条 assistant 消息里只抽出正文（text 块拼起来；reasoning / image 都不要）。 */
/**
 * ⭐ 0.9.9：「这条是不是点了我的名」——@ 了我，或引用的是我发过的消息。纯函数，方便自测。
 */
export function 识别点名(段们, 自己QQ, 己方消息) {
  const 我 = String(自己QQ || '')
  let 点名 = false
  for (const 段 of Array.isArray(段们) ? 段们 : []) {
    if (!段 || !段.data) continue
    const 型 = String(段.type || '')
    if (型 === 'at' && 我 && String(段.data.qq || '') === 我) 点名 = true      // at 全体（qq='all'）不算
    if (型 === 'reply' && 段.data.id != null && 己方消息 && typeof 己方消息.has === 'function'
        && 己方消息.has(String(段.data.id))) 点名 = true
  }
  return 点名
}

export function 提取正文(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/** 拼一个 OneBot「私聊 text 段」消息体。 */
export function 私人消息体(text) {
  return { user_id: 0, message: [{ type: 'text', data: { text } }] }
}

/** 拼一个 OneBot「群 text 段」消息体。 */
export function 群消息体(text) {
  return { group_id: 0, message: [{ type: 'text', data: { text } }] }
}

/** ⭐ 2026-10-22：从一条 assistant 消息里挑出图片块（要发到 QQ 的那几张）。 */
export function 提取图块(message) {
  if (!message || !Array.isArray(message.content)) return []
  return message.content.filter((b) => b && b.type === 'image' && b.attachment).slice(0, 10)
}

/** 拼一个 OneBot「图片段」（base64 直接塞，不依赖 QQ 那边能不能访问本地文件）。 */
export function 图片段(base64) {
  return { type: 'image', data: { file: 'base64://' + String(base64) } }
}

/**
 * ⭐ 2026-10-22：正文里那种 markdown 图片 `![名字](路径)` 也当图片发。
 *    伙伴发贴纸就是这么发的（`![小肥鱼](_stickers/feiyu-test.webp)`）——
 *    以前只认附件块，这种一律被当成普通文字发过去，QQ 那边看到的是一串 markdown。
 * @returns {净文字, 图: [{kind:'url'|'path', value}]}
 */
export function 抠正文图(文字) {
  const 图 = []
  const 净文字 = String(文字 || '')
    .replace(/!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g, (全, 路径) => {
      const p = String(路径 || '').trim()
      if (!p) return ''
      if (/^https?:\/\//i.test(p)) {
        if (!图.some((x) => x.value === p)) 图.push({ kind: 'url', value: p })
        return ''
      }
      if (!图.some((x) => x.value === p)) 图.push({ kind: 'path', value: p })
      return ''
    })
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { 净文字, 图 }
}

// 包根：用来读自己的 package.json（版本 + 仓库地址）
const 包根 = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * ⭐ 1.0.4：把 `[QQ]…[/QQ]` 处理成「真正要发出去的文字」。
 *
 * 三种情况：
 * 1. `只发标记内` 关：整段都发，但**标记本身要剥掉**（以前会原样发到手机上，她截图看到过 `[QQ]`）；
 * 2. 开 + 有完整 `[QQ]…[/QQ]`：只发块里那段；
 * 3. 开 + 只写了开头没写 `[/QQ]`：按「[QQ] 之后全是想发的」发（以前整条都不发，手机上什么都收不到）。
 * 开 + 连 `[QQ]` 都没有 → `发:false`（这一轮不往 QQ 发）。
 * @param 文字 这一轮的正文
 * @param 只发标记内 配置开关
 * @returns {{发: boolean, 文字: string, 原因?: string}}
 */
export function 抠QQ标记(文字, 只发标记内) {
  const 全 = String(文字 || '')
  const 洗 = (s) => String(s || '')
    .replace(/\[\s*\/?\s*QQ\s*\]/gi, '')
    .replace(/\n{3,}/g, String.fromCharCode(10) + String.fromCharCode(10))
    .trim()
  if (!只发标记内) return { 发: true, 文字: 洗(全) }
  const 块 = /\[QQ\]([\s\S]*?)\[\/QQ\]/.exec(全)
  if (块 && String(块[1] || '').trim()) return { 发: true, 文字: 洗(块[1]) }
  const 开 = 全.indexOf('[QQ]')
  const 尾 = 开 >= 0 ? 全.slice(开 + 4) : ''
  if (String(尾).trim()) {
    return { 发: true, 文字: 洗(尾), 原因: '只写了 [QQ] 没写 [/QQ]，按「[QQ] 之后全是要发的」处理' }
  }
  return { 发: false, 文字: '', 原因: '没写块' }
}
export function apply(ctx) {
  // ⭐ 设置页那个「检查更新」：查这个插件自己的仓库
  createSelfUpdate({ packageRoot: 包根, diag: 记账 }).register(ctx, 路由前缀)
  // ---------- 状态 ----------

  const 日志 = []
  // ⚠ 2026-10-23 修（反馈：换过「目标会话」之后，新会话第 2 轮起就静默不发）
  //   真因：这两个表原来都是**全局一份**，只认「轮号」，不认「哪个会话」。
  //     从 A 换到 B 之后，B 的轮号一旦跟 A 撞上，就被当成「这轮已经发过了」跳过；
  //     而调用处是 `void 落地一发(...)`，没有日志 → 日志里一片空白，很难查。
  //   → 现在都按会话分开：上一轮按会话键存一份；已发的键是「会话键:轮号」。
  const 空轮 = emptyReply
  const 上一轮们 = new Map() // 会话键 -> { 轮号, 文本, 图们 }
  const 排队发送 = createDeliveryQueue()
  const privateChat=installPrivateChat(ctx,{home:目录,readConfig:读配置,cleanText:cleanOutgoingText})
  const stopSupplements = registerSupplementReceiver((origin,text) => {
    const conf = 读配置(), key = 会话键(origin?.session)
    const row = (conf.绑定 || []).find(x=>会话键(x.会话)===key)
    const round = 上一轮们.get(key)
    if (!conf.总开关 || conf.试运行 || !row || row.类型!=='私聊' || String(row.号码)!==String(origin?.peer) ||
        !Number.isInteger(origin?.turn) || round?.轮号!==origin.turn || round.closed)
      throw new Error('补充文字不属于当前可发送的 QQ 私聊回合，未入队')
    上一轮们.set(key,appendReply(round,origin.turn,text))
    return {to:origin.peer,queued:true,sent:false,delivery:'turn_end',note:'已加入本轮正文队列，整轮完成后按顺序发送；不要重复正文或追加等待旁白'}
  })
  ctx.on('dispose',()=>{stopSupplements();上一轮们.clear()})
  const 已发轮 = new Set() // 「会话键:轮号」
  const 已转消息 = new Set() // 已经转发进 DSH 的 QQ 消息 id（防重复转）
  // ⚠️ 2026-10-25（她报的「我没发新消息，它却自己回了一条」）：
  //   这两个东西以前**只存在内存里** —— 插件一重启（今天改了鱼的心情 / 换插件都要重启），
  //   「看到哪儿了」就归零 ⇒ 最近那十几条历史消息会**被当成新消息重投一遍**，
  //   于是她一点开会话就冒出一条自动回复。现在落盘到 qq-bridge-state.json，重启接着上次。
  const 状态文件 = join(dirname(配置文件), 'qq-bridge-state.json')
  const 上次时间 = new Map()
  let 水位读错 = false
  let 水位写错 = false
  const 读水位 = () => {
    try {
      const j = JSON.parse(readFileSync(状态文件, 'utf8'))
      if (j && j.上次 && typeof j.上次 === 'object') for (const [k, v] of Object.entries(j.上次)) 上次时间.set(String(k), Number(v) || 0)
      if (j && Array.isArray(j.已转)) for (const id of j.已转.slice(-300)) 已转消息.add(id)
    } catch (error) { 水位读错 = error.code !== 'ENOENT' }
  }
  读水位()
  const 存水位 = () => {
    try {
      writeObject(状态文件, {
        上次: Object.fromEntries([...上次时间].map(([k, v]) => [k, Number(v) || 0])),
        已转: [...已转消息].slice(-300),
      })
      水位写错 = false
    } catch (error) { 水位写错 = true }
  }
  // ⭐ 0.6.0：每个「聊天」各自记「看到哪儿了」（键 = 类型:号码）—— 多群多私聊才不会互相串


  function 记账(文本) {
    const d = new Date()
    const 补 = (n) => String(n).padStart(2, '0')
    const 时间 = `${补(d.getMonth() + 1)}-${补(d.getDate())} ${补(d.getHours())}:${补(d.getMinutes())}:${补(d.getSeconds())}`
    日志.push({ 时间, 文本 })
    if (日志.length > 日志上限) 日志.shift()
    try {
      ctx.logger?.info(`qq-bridge: ${文本}`)
    } catch (error) {}
  }

  /** 请求头：填了「令牌」就带 Bearer；没填就照旧（老 NapCat 不鉴权，零变化） */
  const 请求头 = (配置, 带体 = true) => {
    const h = 带体 ? { 'content-type': 'application/json', 'user-agent': 'dsh-qq-bridge' } : { 'user-agent': 'dsh-qq-bridge' }
    const t = String((配置 && 配置.令牌) || '').trim()
    if (t) h.authorization = 'Bearer ' + t
    return h
  }

  async function 发一个(base, action, 体, 配置) {
    try {
      const r = await requestChannel({...配置,NapCat:base},action, {
        method: 'POST',
        headers: 请求头(配置),
        body: JSON.stringify(体),
        signal: AbortSignal.timeout(25000),
      })
      const j = await r.json()
      const 好 = !!(j && j.status === 'ok' && j.retcode === 0)
      try {
        const 新id = j && j.data ? (j.data.message_id != null ? j.data.message_id : j.data.messageId) : null
        if (好 && 新id != null) 记己方消息(新id)
      } catch (error) {}
      return { action, ok: 好, 数据: j }
    } catch (error) {
      return { action, ok: false, 数据: { 错: String((error && error.message) || error) } }
    }
  }

  /** 尊重模型的换行分段，代码块保持完整。 */
  const 按段拆 = splitReplyBubbles

  /**
   * 相对路径的图按哪儿找：
   *   ① 设置里的「图片根目录」（填了就以它为准）
   *   ② **目标会话所在的那个工作区**（自动的，一般不用填）
   *   ③ 其它登记过的工作区
   *   ④ 进程当前目录 ⑤ <DSH_HOME>/workspace ⑥ 用户主目录
   * 找到就返回绝对路径。
   */
  function 找本地图(p, 配置) {
    const 原 = String(p || '').trim()
    if (!原) return ''
    const 试 = []
    if (/^[a-zA-Z]:[\\/]/.test(原) || 原.startsWith('\\\\') || 原.startsWith('/')) 试.push(原)
    else {
      const 根们 = []
      const 设 = String(配置.图片根目录 || '').trim()
      if (设) 根们.push(设)
      try {
        const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
        const 列表 = (登记 && typeof 登记.list === 'function' ? 登记.list() : []) || []
        const 目标 = String(配置.目标会话 || '')
        // ⭐ 先把「目标会话所在的工作区」排到前面 —— 这个才是它平时待的地方
        const 排 = 列表.slice().sort((a, b) => {
          const A = a && Array.isArray(a.sessionIds) && a.sessionIds.map(String).indexOf(目标) >= 0 ? 0 : 1
          const B = b && Array.isArray(b.sessionIds) && b.sessionIds.map(String).indexOf(目标) >= 0 ? 0 : 1
          return A - B
        })
        for (const w of 排) {
          const d = w && (typeof w.path === 'string' ? w.path : (w.directory || w.dir || w.root))
          if (typeof d === 'string' && d) 根们.push(d)
        }
      } catch (error) {}
      根们.push(process.cwd(), join(目录, 'workspace'), homedir())
      for (const r of 根们) 试.push(join(String(r), 原))
    }
    for (const 全 of 试) {
      try { if (existsSync(全)) return 全 } catch (error) {}
    }
    记账('找不到这张图：' + 原 + '（试过：' + 试.slice(0, 4).join(' ｜ ') + ' 等 ' + 试.length + ' 个位置；可在设置里填「图片根目录」）')
    return ''
  }

  /** 把一句正文发到该发的地方（私聊 / 群）；按空行拆段，一段一条连发。⭐ 末尾再加上图片。 */
  async function 发到QQ(配置, 原文字, 图们, 方向 = '') {
    原文字 = cleanOutgoingText(原文字)
    // ⭐ 0.6.0：方向 = 会话键；拿它反查「这条绑的是哪个聊天」，然后只发那一个
    let 行 = (配置.绑定 || []).find((b) => 会话键(b.会话) === 会话键(方向)) || null
    // ⭐ 0.9.7（用户反馈：「试一句」总说没绑）：手动测试没有会话可反查，
    //    以前这里直接判「没绑任何聊天」→ 设置页的「试一句」永远发不出去，还让人以为绑定坏了。
    //    现在没有会话时就用第一条绑定。
    if (!行 && !会话键(方向)) 行 = (配置.绑定 || [])[0] || null
    const 出 = []
    if (行?.类型 === '群') {
      try { assertTrustedGroup(行, 读配置()) }
      catch { 记账('群隐私检查未通过，已阻止发送'); return 出 }
      配置 = { ...配置, 发图: false }
      图们 = []
      原文字 = String(原文字 || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    }
    // ⭐ 正文里的 markdown 图（贴纸就是这么发的）也当图片发；抠掉之后正文更干净
    const 抠过 = 配置.发图 ? 抠正文图(原文字) : { 净文字: String(原文字 || ''), 图: [] }
    const 文字 = 抠过.净文字
    // ⭐ 2026-10-25（用户反馈）：拆段和间隔以前写死（固定 450ms）——
    //    长回复会变成连着好几条，看着像刷屏。现在两个都能配：不拆 = 一整条发出去。
    const 要拆 = 配置.长回复拆段 !== false
    const 段们 = 要拆 && 按段拆(文字).length
      ? 按段拆(文字)
      : [String(文字 || '').trim()].filter((s) => s.length > 0)
    const 发段延迟 = Math.max(0, Math.min(Number(配置.拆段间隔毫秒) || 0, 5000))
    const 最大 = Math.max(1, Math.min(Number(配置.图上限MB) || 5, 30)) * 1024 * 1024
    // ⭐ 图片：base64 或网络地址，QQ 那边直接收，不用访问本机文件
    const 图数据 = []
    const 加图 = (源) => {
      if (!源 || 图数据.length >= 4) return
      if (源.kind === 'url') { 图数据.push({ url: 源.value }); return }
      let 值 = 源.value
      // ⭐ 伙伴回发时常常照抄 DSH 给的那条「只读副本」路径（webp）——
      //    先反查一次表，能换回我们存的原图就换（GIF 才是动的）
      const 换 = 原图路径('p:' + 清路径(值).toLowerCase())
      if (换) 值 = 换
      const 全 = 找本地图(值, 配置) || 值
      try {
        const buf = readFileSync(全)
        if (buf.length > 最大) { 记账(`这张图太大（${Math.round(buf.length / 1048576)}MB），跳过`); return }
        图数据.push({ b64: buf.toString('base64'), sha256:createHash('sha256').update(buf).digest('hex') })
      } catch (error) {
        记账('读图失败，跳过：' + String((error && error.message) || error))
      }
    }
    if (配置.发图) {
      for (const 源 of 抠过.图) 加图(源)
      if (Array.isArray(图们) && 图们.length) {
        const 附件 = ctx.attachments || ctx.get('attachments')
        for (const 块 of 图们) {
          try {
            // ⭐ 优先用我们收下来的**原图**（DSH 那份副本会被转码，GIF 会变静态）
            const 原 = 原图路径('id:' + String((块.attachment && 块.attachment.attachmentId) || ''))
            if (原) { 加图({ kind: 'path', value: 原 }); continue }
            const p = 附件 && typeof 附件.imageHostPath === 'function' ? 附件.imageHostPath(块.attachment) : undefined
            if (!p) { 记账('这张图拿不到本地文件，跳过'); continue }
            加图({ kind: 'path', value: p })
          } catch (error) {
            记账('读图失败，跳过：' + String((error && error.message) || error))
          }
        }
      }
    }
    // 一条 OneBot 图片段：本地图走 base64，网络图直接把 url 交给 QQ
    const 一段图 = (x) => (x.url ? { type: 'image', data: { file: x.url, url: x.url } } : 图片段(x.b64))

    if (!行) {
      记账(会话键(方向)
        ? '这间会话（' + 短id(方向) + '）没有绑定聊天 —— 这一轮不往 QQ 发（去「绑定」页加一条）'
        : '还没绑定任何一个聊天 —— 去「绑定」页加一条（一行 = 一个聊天 → 一间会话）')
      return 出
    }
    const 要私聊 = 行.类型 !== '群' && 配置.转私聊
    const 要群 = 行.类型 === '群' && 配置.转群
    if (要私聊) {
      for (let i = 0; i < 段们.length; i++) {
        const 体 = 私人消息体(段们[i])
        体.user_id = Number(行.号码)
        出.push(await 发一个(配置.NapCat, 'send_private_msg', 体, 配置))
        if (i < 段们.length - 1) await new Promise((r) => setTimeout(r, 发段延迟))
      }
      for (const x of 图数据) {
        const r=await 发一个(配置.NapCat, 'send_private_msg', { user_id: Number(行.号码), message: [一段图(x)] }, 配置)
        出.push({...r,imageSha256:x.sha256||null,image:true})
        await new Promise((r) => setTimeout(r, 发段延迟))
      }
    }
    if (要群) {
      for (let i = 0; i < 段们.length; i++) {
        const 体 = 群消息体(段们[i])
        体.group_id = Number(行.号码)
        assertTrustedGroup(行, 读配置())
        const sent=await 发一个(配置.NapCat, 'send_group_msg', 体, 配置)
        出.push(sent)
        if(!sent.ok)try{群主动.outcome(行,'delivery_failed')}catch{}
        if(sent.ok)try{群主动.sent(行,[sent.数据?.data?.message_id??sent.数据?.data?.messageId])}catch{记账('群回复引用记录保存失败')}
        if (i < 段们.length - 1) await new Promise((r) => setTimeout(r, 发段延迟))
      }
      for (const x of 图数据) {
        出.push(await 发一个(配置.NapCat, 'send_group_msg', { group_id: Number(行.号码), message: [一段图(x)] }, 配置))
        await new Promise((r) => setTimeout(r, 发段延迟))
      }
    }
    return 出
  }

  /** 一轮真正落地：总开关 / 试运行 在这儿把关。 */
  async function 落地一发(配置, 文字, 图们, 方向 = '', 是QQ唤醒 = false) {
    // ⭐ 模型把工具调用写成了正文（@@<工具调用>…</工具调用>），这种绝不能发到 QQ
    {
      const 原文 = String(文字 || '')
      if (/<工具调用>|<\/工具调用>|(^|\n)\s*qq_reply_gate\s*\(/.test(原文)) {
        记账('这一轮是工具调用文本，不发到 QQ')
        if (/qq_reply_gate\s*\(\s*reply\s*[=:]\s*false/i.test(原文)) 静默轮.add(会话键(方向))
        return
      }
    }
    if (已发轮.size > 300) 已发轮.clear() // 防 Set 无限长
    // ⭐ 0.6.0：方向就是「哪一间会话」—— 下面按它去绑定里反查该发到哪个聊天
    const 这份会话 = String(方向 || '')
    if (!这份会话) return 记账('这一轮认不出是哪间会话，这轮不转')
    配置 = { ...配置, 目标会话: 这份会话 }   // 下游（图片根目录、归档检查）都看这一个
    // ⭐ 盯的会话已经归档了：别转（人已经不在这儿说话了）
    try {
      const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
      const 归档 = new Set((((登记 && 登记.archivedSessionIds) || [])).map(String))
      if (归档.has(会话键(这份会话))) return 记账('这间会话已经归档了，这轮不转（去绑定里换一间）')
    } catch (error) {}
    if (!配置.总开关) return 记账('总开关关着，这轮该转但没转')
    // ⭐ 0.7.0 出站闸一：只发 [QQ]…[/QQ] 里的那一段（块外的解释/路径/思考留在本地）
    // ⭐ 1.0.4：标记本身永远不往 QQ 里发；只写了开头没写结尾也照发（见 抠QQ标记）
    const 标记 = 抠QQ标记(文字, 配置.只发标记内)
    if (!标记.发) {
      记账('这一轮没写 [QQ]…[/QQ] 块（「只发标记内」开着）—— 这轮不往 QQ 发')
      return
    }
    if (标记.原因) 记账(标记.原因)
    let 待发文字 = cleanOutgoingText(标记.文字)
    if (!待发文字 && !图们?.length) {
      记账('这一轮没有可发送的正文或附件，内部控制标记不会发送到 QQ')
      return {sent:false,silent:true}
    }
    // ⭐ 0.7.0 出站闸二：只发「被 QQ 消息叫醒的那一轮」（你坐在 DSH 里自己聊的不推到手机）
    if (配置.只回QQ唤醒) {
      if (!是QQ唤醒) {
        记账('这一轮不是 QQ 消息叫醒的（「只回 QQ 唤醒」开着）—— 只在 DSH 里说，不推 QQ')
        return
      }
    }
    const 抠过 = 配置.发图 ? 抠正文图(待发文字) : { 净文字: 待发文字, 图: [] }
    const 几张 = (Array.isArray(图们) ? 图们.length : 0) + 抠过.图.length
    const 图标 = 几张 ? `（还有 ${几张} 张图）` : ''
    const 净文 = String(抠过.净文字 || '')
    if (配置.试运行) {
      return 记账(`试运行：本来要发到 QQ →「${净文.slice(0, 40)}${净文.length > 40 ? '…' : ''}」${图标}`)
    }
    const 结果 = await 发到QQ(配置, 待发文字, 图们, 方向)
    const 全过 = 结果.length > 0 && 结果.every((r) => r.ok)
    if (结果.length === 0) {
      记账('这一边（' + (方向 || '私聊+群') + '）没开或没填号，或者这轮既没有文字也没有图（而且图都没转成）：没地方发')
      return
    }
    记账(`${全过 ? '✅ 已发到 QQ：' : '⚠ 发 QQ 有问题：'}「${净文.slice(0, 50)}${净文.length > 50 ? '…' : ''}」${图标}`)
    for (const r of 结果) {
      if (!r.ok) 记账(`   ${r.action} 失败：${JSON.stringify(r.数据).slice(0, 140)}`)
    }
    return {sent:全过,text:净文,imageReceipts:结果.filter(r=>r.image&&r.ok).map(r=>({sha256:r.imageSha256,messageId:r.数据?.data?.message_id??r.数据?.data?.messageId})).filter(r=>r.messageId!==undefined&&r.messageId!==null)}
  }

  /** 盯会话事件：保留这一轮所有可见正文，在 turn/end 时有序落地。 */
  function 收到事件(session, event) {
    const 配置 = 读配置()
    if (!(配置.绑定 || []).length) return
    const 键 = 会话键(session && session.id)
    // ⭐ 0.6.0：哪一间会话说的话，就按它的绑定只回那一个聊天
    const 是这条 = (配置.绑定 || []).find((b) => 会话键(b.会话) === 键) || null
    if (!是这条) return
    const 方向 = 键
    const privateWebReply=privateChat.ownsEvent(session,event)
    // 这一轮的「最后一句」按会话分开记（两个会话同时说话时不会串）
    const 上一轮 = 上一轮们.get(键) || 空轮()
    const 记上一轮 = (v) => 上一轮们.set(键, v)

    if (event?.type === 'turn/start') {记上一轮(空轮(event.data?.turn));privateProactive.start(键,event.data?.turn);purposeReceipts.start(键,event.data?.turn);imageDeliveryReceipts.start(键,event.data?.turn)}
    if (event?.type === 'turn/start' && 是这条.类型 === '群') {
      群判定.set(键, { turn: event.data?.turn, reply: false, decided:false, input:null })
      return
    }
    if (event && event.type === 'assistant/message') {
      const d = event.data || {}
      if (d.interrupted) {
        记上一轮(空轮())
        return
      }
      const 文 = String(提取正文(d.message) || '').trim()
      const 图们 = 提取图块(d.message)
      if (是这条.类型 === '群') recordGroupOutput(群判定.get(键), d.turn, 文)
      记上一轮(appendReply(上一轮,d.turn,文,图们))
      return
    }

    // ⭐ 1.0.1：她自己在这间会话里打了字（source 不是 qq）→ 尾巴立刻清掉，
    //   不然「QQ 叫醒一次」会把后面她自己聊的几轮也推去手机（老坑）。
    if (event && event.type === 'user/message') {
      privateProactive.input(配置,是这条,event.data?.message||event.data)
      imageDeliveryReceipts.input(配置,是这条,event.data?.message||event.data)
      purposeReceipts.input(键,event.data?.message||event.data)
      if(是这条.类型==='群'){
        const input=群输入证据.take(键,提取正文(event.data?.message||event.data))
        const decision=群判定.get(键)
        if(input && decision){
          const alreadyDirected=decision.input?.source==='qq' && decision.input?.directed===true
          decision.input={...input,directed:input.directed===true || alreadyDirected}
          // Only newly consumed transport evidence may reopen a declined choice.
          decision.declined=false;decision.decided=false;decision.reply=false
        }
      }
      const 源 = event.data?.source || event.data?.message?.source
      const 类 = String((源 && 源.kind) || '')
      if (!类 || 类 === 'user') 尾巴.delete(键)
      return
    }

    if (event && event.type === 'turn/end') {
      const d = event.data || {}
      if (上一轮.轮号 === d.turn) 上一轮.closed = true
      const imageReceipt=imageDeliveryReceipts.finish(配置,是这条,d.turn)
      if(imageReceipt&&(d.reason?.kind!=='completed'||!上一轮.文本))imageReceipt.settle({phase:'needs_check',reason:'no_completed_response'})
      const purposeReceipt=purposeReceipts.finish(键,d.turn)
      const purposeToken=purposeReceipt?.cancelled?null:purposeReceipt?.token
      if(purposeReceipt?.cancelled)purpose.settle(purposeReceipt.token,'cancelled')
      if(purposeToken&&d.reason?.kind!=='completed')purpose.settle(purposeToken,'generation_failed')
      if(purposeToken&&d.reason?.kind==='completed'&&(!cleanOutgoingText(抠QQ标记(上一轮.文本,false).文字)&&!上一轮.图们?.length))purpose.settle(purposeToken,String(上一轮.文本||'').includes('[PAOPAO_SILENT]')?'silent':'empty_output')
      const 可信主动私聊=privateProactive.finish(配置,是这条,d.turn)
      if(可信主动私聊 && d.reason?.kind!=='completed')privateActivity.record('generation_failed')
      if(可信主动私聊 && d.reason?.kind==='completed' && !cleanOutgoingText(抠QQ标记(上一轮.文本,false).文字) && !上一轮.图们?.length){
        const explicitSilence=String(上一轮.文本||'').includes('[PAOPAO_SILENT]')
        privateActivity.record(explicitSilence?'silent':'empty_output')
        记上一轮(空轮());记账(explicitSilence?'主动私聊：本轮选择安静，不发送消息':'主动私聊：模型没有返回正文，记录为空输出故障');return
      }
      const decision = 群判定.get(键)
      群判定.delete(键)
      const groupAllowed = 是这条.类型 !== '群' || (群主动.allowsDelivery(是这条,decision?.input?.source) && groupReplyAllowed(decision,d.turn))
      if(purposeToken&&!groupAllowed)purpose.settle(purposeToken,'silent')
      const 完成 = !!(d.reason && d.reason.kind === 'completed') && groupAllowed && !privateWebReply
      if(是这条.类型==='群')try{
        if(d.reason?.kind!=='completed')群主动.outcome(是这条,'generation_failed')
        else if(!groupAllowed)群主动.outcome(是这条,decision?.decided?'model_declined':'gate_missing')
      }catch{}
      const 有东西 = 上一轮.文本 || (上一轮.图们 && 上一轮.图们.length)
      // ⚠ 去重的键必须是「会话 + 轮号」：只按轮号的话，换过目标会话就会静默漏发
      const 轮标 = 键 + ':' + String(d.turn)
      if (完成 && 上一轮.轮号 === d.turn && 有东西 && !已发轮.has(轮标)) {
        已发轮.add(轮标)
        // ⚠️ 「这轮是不是 QQ 叫的」在**这里**算一次就消费掉 —— 不然 10 分钟的窗口会把
        //    后面别的轮次也当成 QQ 叫的（实测踩过：群里一条旧消息叫醒之后，之后几轮都往外发）。
        const 醒 = 唤醒时间.get(键) || null
        const 醒着 = Boolean(醒 && 醒.时 && Date.now() - 醒.时 < QqWalake窗口)
        // ⭐ 1.0.1（issue #6）：这次真被 QQ 唤醒 → 给它留一条尾巴，
        //    「这次触发」下面紧接着的几轮也照样往外发（以前只有第一轮能出去）。
        if (醒着) {
          const 尾巴毫秒 = Math.max(0, Number(读配置().唤醒尾巴秒) || 0) * 1000
          if (尾巴毫秒 > 0) 尾巴.set(键, Date.now() + 尾巴毫秒)
        }
        唤醒时间.delete(键)
        const 尾到 = 尾巴.get(键) || 0
        const 是QQ唤醒 = 醒着 || 尾到 > Date.now() || 可信主动私聊 || Boolean(imageReceipt)
        if (尾到 && 尾到 <= Date.now()) 尾巴.delete(键)
        // 门槛判了「不接」→ 这一轮一个字都不往外发（但会话里照常留着）
        if (静默轮.has(键)) {
          静默轮.delete(键)
          purpose.settle(purposeToken,'silent')
          imageReceipt?.settle({phase:'declined',reason:'reply_gate_declined'})
          记账('回复门槛：这一轮按判定跳过发送（' + 短id(键) + '）')
        } else {
          void 排队发送(键,()=>是这条.类型==='群'&&!群主动.allowsDelivery(是这条,decision?.input?.source)?{sent:false,silent:true,reason:'group_proactive_disabled'}:落地一发(配置, 上一轮.文本, 上一轮.图们, 方向, 是QQ唤醒)).then(result=>{imageReceipt?.settle(result||{phase:'needs_check',reason:'delivery_suppressed'});purpose.settle(purposeToken,result?.sent?'sent':result?.silent?'silent':'delivery_failed',result?.text||'');if(可信主动私聊)privateActivity.record(result?.sent?'sent':'delivery_failed')}).catch(()=>{imageReceipt?.settle({phase:'needs_check',reason:'delivery_failed'});purpose.settle(purposeToken,'delivery_failed');if(可信主动私聊)privateActivity.record('delivery_failed');记账('消息发送流程失败');if(是这条.类型==='群')try{群主动.outcome(是这条,'delivery_failed')}catch{}})
        }
      }
      记上一轮(空轮())
    }
  }

  // ---------- 路由（将来给设置页用；现在也能用来手动试） ----------

  const 回 = (res, o) => {
    try {
      res.setHeader?.('content-type', 'application/json; charset=utf-8')
      res.end?.(JSON.stringify(o))
    } catch (error) {}
  }

  const 读体 = async (req) => {
    let body = ''
    try {
      for await (const chunk of req) body += chunk
    } catch (error) {}
    try {
      return JSON.parse(body || '{}')
    } catch (error) {
      return {}
    }
  }

  const 短id = (id) => {
    const s = String(id)
    return s.length <= 8 ? s : s.slice(-8)
  }

  /** 从进程命令行里抠 token / 端口（DSH 启动时带 --token= / 端口就在 argv 里） */
  function 本机服务信息() {
    let token = String(process.env.DSH_WEB_TOKEN || '')
    // ⭐ 服务启动时会把这次生成的 token 落到这个文件（见 /usr/local/bin/dsh-token-dump.sh）
    if (!token) {
      try {
        const p = String(process.env.DSH_HOME || '/srv/dsh-cloud/home').replace(/\/$/, '') + '/.web-token'
        if (existsSync(p)) token = readFileSync(p, 'utf8').trim()
      } catch (error) {}
    }
    let port = String(process.env.DSH_WEB_PORT || '')
    for (const a of process.argv) {
      const t = /token[= ]([A-Za-z0-9_-]{16,})/.exec(String(a))
      if (t) token = t[1]
      const p = /(?:--port[= ]|:)(\d{4,5})\b/.exec(String(a))
      if (p && !port) port = p[1]
    }
    return { token, port: port || '29908' }
  }

  const _cookie = { v: '', at: 0 }

  /** 用 token 换一个 dsh-auth cookie（30 分钟缓存） */
  async function 取cookie() {
    if (_cookie.v && Date.now() - _cookie.at < 30 * 60 * 1000) return _cookie.v
    const { token, port } = 本机服务信息()
    if (!token) throw new Error('拿不到本机 token（argv 里没有）')
    // 用 node:http 拿原始响应头（fetch 在 Node 里会把 set-cookie 藏起来或跟随跳转）
    const http = await import('node:http')
    const raw = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: Number(port), path: `/?token=${encodeURIComponent(token)}`, method: 'GET' },
        (res) => {
          const list = res.headers['set-cookie'] || []
          resolve(Array.isArray(list) ? list.join('; ') : String(list))
          res.resume()
        },
      )
      req.on('error', reject)
      req.setTimeout(10000, () => req.destroy(new Error('拿 cookie 超时')))
      req.end()
    })
    const m = /(dsh-auth-[^=]+=[^;]+)/.exec(raw)
    if (!m) throw new Error('换 cookie 失败（没拿到 set-cookie）')
    _cookie.v = m[1]
    _cookie.at = Date.now()
    return _cookie.v
  }

  /** 走本地 HTTP 的 session/prompt：会话没开着也能唤醒它跑一轮 */
  async function 走HTTP投递(会话, content) {
    const { port } = 本机服务信息()
    const cookie = await 取cookie()
    const rpcId = 新id()
    const body = {
      type: 'client-request',
      rpcId,
      method: 'session/prompt',
      payload: {
        args: {
          request: {
            requestId: 新id(),
            sessionId: String(会话),
            mode: 'queue',
            // HTTP 通道只接受纯文本（图片要走上传统的 upload 凭证，会校验失败）
            content: (() => {
              const texts = (Array.isArray(content) ? content : [])
                .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
                .map((p) => ({ type: 'text', text: p.text }))
              if (texts.length) return texts
              return [{ type: 'text', text: '（他发来的是图片，这条通道暂时看不到图）' }]
            })(),
            clientTimeZone: 'Asia/Shanghai',
          },
        },
      },
    }
    const res = await fetch(`http://127.0.0.1:${port}/api/session/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    let ok = false
    let err = ''
    try {
      const j = JSON.parse(text)
      ok = Boolean(j && j.result && j.result.ok)
      err = (j && j.result && j.result.error && (j.result.error.message || j.result.error.code)) || ''
    } catch (error) {
      err = text.slice(0, 120)
    }
    if (!ok) {
      _cookie.at = 0   // cookie 可能过期，下次重换
      throw new Error('HTTP 投递被拒：' + (err || '未知'))
    }
    记账('会话 ' + 短id(会话) + ' 没开着，已用 HTTP 唤醒并投递')
  }
  /* 拿目标会话活着的 agent：带 / 不带 `session-` 前缀两个方向都试（照 speak-up 的写法）。 */
  const 找agent = (id) => {
    const 原 = String(id == null ? '' : id).trim()
    if (原 === '') return undefined
    const 候选 = [原]
    if (原.startsWith('session-')) 候选.push(原.slice('session-'.length))
    else 候选.push('session-' + 原)
    for (const 一个 of 候选) {
      try {
        const a = ctx.agents.get(一个)
        if (a !== undefined) return a
      } catch (error) {}
    }
    return undefined
  }

  const 新id = () => {
    try {
      return randomUUID()
    } catch (error) {
      return 'qq-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    }
  }

  /** 手搓一条 user 消息（跟 speak-up 一样：role=user，source.kind 标成 qq，不冒充她亲手打的）。 */
  const 手搓用户消息 = (文案) => ({
    id: 新id(),
    role: 'user',
    content: [{ type: 'text', text: String(文案) }],
    source: { kind: 'qq' },
  })

  /** 现在开着的会话清单（id + 标题），给设置页挑「目标会话」用 —— 不手填。 */
  const 会话清单 = () => {
    const 出 = []
    // ⭐ 归档的会话不列（归档只是藏起来，list() 里还在 —— 得单独查 workspaceRegistry 的名单）
    //   2026-10-20 修：以前完全不看归档，设置页里挑会话时混着一堆已经归档的
    const 归档 = new Set()
    try {
      const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
      for (const x of (登记 && 登记.archivedSessionIds) || []) 归档.add(String(x))
    } catch (error) {}
    try {
      const 会话服务 = ctx.get('sessions')
      const 标题服务 = ctx.get('sessionTitle')
      if (会话服务 && typeof 会话服务.list === 'function') {
        for (const s of 会话服务.list()) {
          if (归档.has(String(s.id))) continue
          let 标题 = ''
          try {
            const 快照 = 标题服务 && typeof 标题服务.get === 'function' ? 标题服务.get(s) : undefined
            标题 = 快照 && 快照.title ? String(快照.title) : ''
          } catch (error) {}
          出.push({ id: String(s.id), 标题 })
        }
      }
    } catch (error) {}
    return 出
  }

  /** ⭐ 0.9.10：连 NapCat 一律带超时。
   *  以前没超时：地址填错 / NapCat 没开 / 防火墙吞包时，fetch 会一直挂着 →
   *  /state 永远不回 → 设置页卡在「读取中…」（用户截图报的就是这个）。 */
  const 探活超时 = Math.max(200, Number(process.env.QQ_BRIDGE_探活超时) || 6000)
  const 带超时 = async (地址, 选项 = {}, 毫秒 = 探活超时) => {
    const 控 = new AbortController()
    const 定 = setTimeout(() => 控.abort(), Math.max(500, 毫秒))
    try {
      return await fetch(地址, { ...选项, signal: 控.signal })
    } finally {
      clearTimeout(定)
    }
  }

  const 概况 = async () => {
    const 配置 = 读配置()
    const 清单 = 会话清单()
    let NapCat状态 = null
    try {
      const r = await 带超时(`${配置.NapCat}/get_login_info`, { method: 'POST', headers: 请求头(配置), body: '{}' })
      const j = await r.json()
      if (j && j.status === 'ok') NapCat状态 = { 用户: j.data.user_id, 昵称: j.data.nickname }
    } catch (error) {
      NapCat状态 = { 错: String((error && error.message) || error) }
    }
    const 在清单里 = (id) => (id && 清单.length ? 清单.filter((x) => 会话键(x.id) === 会话键(id)) : [])
    const 标题表 = new Map(清单.map((x) => [会话键(x.id), x.标题 || ('…' + 短id(x.id))]))
    const 绑定们 = (配置.绑定 || []).map((x) => ({
      ...x,
      会话标题: 标题表.get(会话键(x.会话)) || '',
      活着: 清单.some((y) => 会话键(y.id) === 会话键(x.会话)),
    }))
    return {
      ok: true, 版本, 配置, 配置文件, NapCat状态, 活着的会话: 清单, 日志,
      // ⭐ 2026-10-25：私聊 / 群两个方向各自的会话（老字段 目标情况 还留着 = 私聊那份）
      私聊情况: 在清单里(配置.私聊会话),
      群情况: 在清单里(配置.群会话),
      目标情况: 在清单里(配置.私聊会话),
      绑定: 绑定们,
    }
  }

  // ── 语音转写依赖：一键装（2026-10-25）─────────────────────────────
  //  她说的对：不能「我替她装就装了」—— 插件页里要有开关 + 一个按钮，点了才装，
  //  装的时候能看见进度和报错。这里只负责**起进程 + 记日志**，前端轮询看进度。
  const ASR家 = join(dirname(配置文件), 'qq-bridge-asr')
  const ASR日志 = join(ASR家, 'install.log')
  const ASRvenv = join(ASR家, '.venv')
  const ASRpython = process.platform === 'win32'
    ? join(ASRvenv, 'Scripts', 'python.exe')
    : join(ASRvenv, 'bin', 'python')
  let ASR装 = { 进行中: false, 步骤: [], 开始于: 0, 结束于: 0, 失败: '', 完成: false, 下载: null }

  const ASR写 = (行) => {
    try {
      mkdirSync(ASR家, { recursive: true })
      writeFileSync(ASR日志, '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + 行 + String.fromCharCode(10), { flag: 'a' })
    } catch (error) {}
  }
  const ASR读日志 = (行数 = 40) => {
    try {
      const 全部 = readFileSync(ASR日志, 'utf8').split(String.fromCharCode(10))
      return 全部.slice(-行数).join(String.fromCharCode(10)).trim()
    } catch (error) { return '' }
  }
  const ASR就绪 = () => existsSync(ASRpython)
  // ⭐ 2026-10-25（她说的「别人哪知道模型目录填什么」）：模型由插件自己下、自己放，
  //   用户不需要知道任何路径。「语音模型目录」那一栏只是**给你看/改**的，不该让人手填。
  const ASR模型根 = join(ASR家, 'models')
  const ASR模型名 = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
  const ASR模型目录 = () => join(ASR模型根, ASR模型名)
  const ASR模型就绪 = () => existsSync(join(ASR模型目录(), 'model.int8.onnx')) && existsSync(join(ASR模型目录(), 'tokens.txt'))
  // ⚠️ 2026-10-25（她实测）：官方那个 tar.bz2 有 **999MB** —— 因为把 fp32 模型也打进去了。
  //    我们只需要 int8 的 model.int8.onnx + tokens.txt（约 230MB + 1MB），
  //    所以改成**按文件下**（HuggingFace 上单个文件，另配 hf-mirror 兜底）。
  const ASR文件 = [
    { 名: 'model.int8.onnx', 约MB: 230 },
    { 名: 'tokens.txt', 约MB: 1 },
  ]
  const ASR文件地址们 = (名) => [
    'https://huggingface.co/csukuangfj/' + ASR模型名 + '/resolve/main/' + 名,
    'https://hf-mirror.com/csukuangfj/' + ASR模型名 + '/resolve/main/' + 名,
  ]

  /** 起一条命令，输出追加进日志；返回 {码} */
  const ASR跑 = (命令, 参数, 说明) => new Promise((resolve) => {
    ASR写('▶ ' + 说明 + '：' + 命令 + ' ' + 参数.join(' '))
    let 子 = null
    try {
      子 = spawn(命令, 参数, { cwd: ASR家, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } })
    } catch (error) {
      ASR写('✗ 起不来：' + String((error && error.message) || error))
      return resolve({ 码: -1 })
    }
    子.stdout.on('data', (c) => ASR写(String(c).trim().slice(-400)))
    子.stderr.on('data', (c) => ASR写(String(c).trim().slice(-400)))
    子.on('error', (e) => { ASR写('✗ ' + String((e && e.message) || e)); resolve({ 码: -1 }) })
    子.on('close', (码) => resolve({ 码: 码 === null ? -1 : 码 }))
  })

  async function 装语音依赖() {
    if (ASR装.进行中) return { ok: false, 说: '正在装，别急' }
    ASR装 = { 进行中: true, 步骤: [], 开始于: Date.now(), 结束于: 0, 失败: '', 完成: false, 下载: null }
    const 推 = (名, 态, 附) => {
      const 已 = ASR装.步骤.find((x) => x.名 === 名)
      if (已) { 已.态 = 态; if (附) 已.附 = 附 } else ASR装.步骤.push({ 名, 态, 附: 附 || '' })
    }
    const 找python = async () => {
      for (const 候选 of (process.platform === 'win32' ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]])) {
        const r = await ASR跑(候选[0], [...候选[1], '-V'], '看看有没有 ' + 候选[0])
        if (r.码 === 0) return 候选
      }
      return null
    }
    try {
      mkdirSync(ASR家, { recursive: true })
      ASR写('== 开始装语音识别依赖 ==')
      推('找 Python', '进行中')
      const py = await 找python()
      if (!py) {
        推('找 Python', '失败', '没找到 python / py')
        ASR装.失败 = '这台机器上没找到 Python（装它：https://www.python.org/downloads/）'
        return
      }
      推('找 Python', '完成', py[0])
      if (!ASR就绪()) {
        推('建独立环境', '进行中')
        const r1 = await ASR跑(py[0], [...py[1], '-m', 'venv', ASRvenv], '建 venv')
        if (r1.码 !== 0) {
          推('建独立环境', '失败', '退出码 ' + r1.码)
          ASR装.失败 = '建 venv 失败，看下面日志'
          return
        }
        推('建独立环境', '完成')
      } else 推('建独立环境', '完成', '已经有了')
      推('装 sherpa-onnx', '进行中')
      const r2 = await ASR跑(ASRpython, ['-m', 'pip', 'install', '--no-input', 'sherpa-onnx>=2', 'numpy', 'imageio-ffmpeg'], 'pip install')
      if (r2.码 !== 0) {
        推('装 sherpa-onnx', '失败', '退出码 ' + r2.码)
        ASR装.失败 = '装依赖失败（可能是网速/镜像问题，看日志最后几行）'
        return
      }
      推('装 sherpa-onnx', '完成')
      推('自检', '进行中')
      const r3 = await ASR跑(ASRpython, ['-c', 'import sherpa_onnx, numpy, imageio_ffmpeg; print("sherpa_onnx ok")'], '自检 import')
      if (r3.码 !== 0) {
        推('自检', '失败')
        ASR装.失败 = '装完了但 import 不进来，看日志'
        return
      }
      推('自检', '完成')
      // ④ 语音模型：按文件下（约 230MB + 1MB）—— 有就跳过
      if (ASR模型就绪()) 推('下载语音模型', '完成', '已经有了')
      else {
        mkdirSync(ASR模型目录(), { recursive: true })
        let 全好 = true
        for (const f of ASR文件) {
          const 目标 = join(ASR模型目录(), f.名)
          if (existsSync(目标)) { ASR写('已有 ' + f.名 + '，跳过'); continue }
          推('下载 ' + f.名, '进行中', '约 ' + f.约MB + 'MB')
          let 好 = false
          for (const 地址 of ASR文件地址们(f.名)) {
            ASR写('下载 ' + f.名 + ' ← ' + 地址)
            好 = await (async () => {
              let 写流 = null
              try {
                const r = await fetch(地址, { redirect: 'follow' })
                if (!r || !r.ok) { ASR写('  ✗ HTTP ' + (r && r.status)); return false }
                const 总 = Number(r.headers.get('content-length') || 0)
                写流 = createWriteStream(目标 + '.part')
                let 收 = 0
                const 起2 = Date.now()
                ASR装.下载 = { 文件: f.名, 已收: 0, 总, 百分比: 0, 速度KB: 0 }
                for await (const 块 of r.body) {
                  收 += 块.length
                  if (!写流.write(Buffer.from(块))) await new Promise((res) => 写流.once('drain', res))
                  const 秒 = Math.max(0.5, (Date.now() - 起2) / 1000)
                  ASR装.下载 = { 文件: f.名, 已收: 收, 总, 百分比: 总 ? Math.min(100, Math.round((收 / 总) * 100)) : 0, 速度KB: Math.round(收 / 1024 / 秒), 用时秒: Math.round(秒) }
                  if (收 % (16 * 1024 * 1024) < 块.length) ASR写('  已下 ' + Math.round(收 / 1048576) + 'MB' + (总 ? ' / ' + Math.round(总 / 1048576) + 'MB' : '') + '（' + (ASR装.下载.百分比 || 0) + '%）')
                }
                await new Promise((res) => 写流.end(res))
                写流 = null
                renameSync(目标 + '.part', 目标)
                ASR写('  ✓ ' + f.名 + ' 完成（' + Math.round(收 / 1048576) + 'MB）')
                return true
              } catch (error) {
                try { if (写流) 写流.destroy() } catch (error2) {}
                ASR写('  ✗ ' + String((error && error.message) || error))
                return false
              }
            })()
            if (好) break
          }
          if (!好) { 推('下载 ' + f.名, '失败', '两个源都没成功'); ASR装.失败 = '语音模型没下下来（' + f.名 + '）—— 再点一次会接着下已完成的'; 全好 = false; break }
          推('下载 ' + f.名, '完成')
        }
        if (全好) 推('下载语音模型', ASR模型就绪() ? '完成' : '失败', ASR模型就绪() ? '' : '下完了但文件不对')
        if (!全好 || !ASR模型就绪()) {
          if (!ASR装.失败) ASR装.失败 = '语音模型没下完 —— 再点一次「自动装依赖」会接着下（已完成的会跳过）'
          return
        }
      }
      // ⑤ 把配置里那两栏写好（用户不用知道路径）
      try {
        const 现 = 读配置()
        const 新 = { ...现, 转写命令: ASR命令(ASR模型目录()), 语音模型目录: ASR模型目录() }
        写配置(新)
        ASR写('已把「转写命令 / 语音模型目录」写进配置')
      } catch (error) { ASR写('写配置失败（不影响使用）：' + String((error && error.message) || error)) }
      ASR装.完成 = true
      ASR写('== 装完了 ==')
    } catch (error) {
      ASR装.失败 = String((error && error.message) || error)
      ASR写('✗ 意外错误：' + ASR装.失败)
    } finally {
      ASR装.进行中 = false
      ASR装.结束于 = Date.now()
    }
  }

  /** 装好的那套要用的命令（前端「一键填好」也用这个） */
  const ASR命令 = (模型目录) => {
    const 脚本 = join(PACKAGE_ROOT, 'tools', 'asr_cli.py')
    const 模 = String(模型目录 == null ? (读配置().语音模型目录 || '') : 模型目录).trim()
    return '"' + ASRpython + '" "' + 脚本 + '" "{file}"' + (模 ? ' --模型目录 "' + 模 + '"' : '')
  }

  const 路线 = (路径, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: 路径,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            回(res, { ok: false, 说: String((error && error.message) || error) })
          }
        },
      }),
    )

  // ── 语音转写：装依赖 / 看进度 / 一键填命令 ──────────────────────
  路线(`${路由前缀}/asr-status`, async (req, res) => {
    return 回(res, {
      ok: true,
      就绪: ASR就绪(),
      模型就绪: ASR模型就绪(),
      模型目录: ASR模型目录(),
      进行中: ASR装.进行中,
      步骤: ASR装.步骤,
      完成: ASR装.完成,
      失败: ASR装.失败,
      下载: ASR装.下载,
      用时秒: ASR装.开始于 ? Math.round(((ASR装.结束于 || Date.now()) - ASR装.开始于) / 1000) : 0,
      日志: ASR读日志(40),
      命令: ASR命令(ASR模型就绪() ? ASR模型目录() : ''),
      python: ASR就绪() ? ASRpython : '',
    })
  })

  路线(`${路由前缀}/asr-install`, async (req, res) => {
    await 读体(req)
    记账('点了「装语音识别依赖」—— 后台开始，进度看设置页')
    void 装语音依赖()          // ⚠ 不等它：装依赖可能几分钟，不能把请求挂住（bili 那边踩过这个坑）
    return 回(res, { ok: true, 说: '开始装了，进度会显示在下面（可以关掉设置页，装完日志还在）' })
  })

  路线(`${路由前缀}/state`, async (req, res) => {
    await 读体(req)
    try {
      return 回(res, await 概况())
    } catch (error) {
      // ⭐ 0.9.10：概况里出什么事都不能让设置页一直转圈 —— 至少把版本、配置、日志给出去
      try { 记账('设置页读状态时出错（已用兜底数据）：' + String((error && error.message) || error)) } catch (e0) {}
      try {
        return 回(res, {
          ok: true, 版本, 配置: 读配置(), 配置文件, NapCat状态: { 错: String((error && error.message) || error) },
          活着的会话: 会话清单(), 绑定: [],
 主人号码: '', // ⭐ 主人的 QQ 号：这一行的会话算「家人」，其它绑定都算「客人」 私聊情况: [], 群情况: [], 目标情况: [], 日志,
        })
      } catch (e2) {
        return 回(res, { ok: false, 说: '状态读不出来：' + String((error && error.message) || error) })
      }
    }
  })

  路线(`${路由前缀}/save`, async (req, res) => {
    const 来 = await 读体(req)
    const 现在 = 读配置()
    const 新 = { ...现在, ...(来 && typeof 来 === 'object' ? 来 : {}) }
    let 洗好
    try {
      validateBindings(新)
      洗好 = 归一化(新)
      sealGroupBindings(ctx, 洗好)
    } catch (error) { return 回(res, { ok: false, 说: String(error?.message || '群隔离检查未通过') }) }
    if (!写配置(洗好)) return 回(res, { ok: false, 说: `写不进配置文件：${配置文件}` })
    const 状态 = 洗好.总开关 ? (洗好.试运行 ? '（只记账）' : '（真发）') : '（总开关关着）'
    // ⭐ 0.6.0：报「几条绑定」＋ 挡掉了几个重复（同一个会话 / 同一个聊天只能绑一条）
    const 想绑 = Array.isArray(来 && 来.绑定) ? 来.绑定.filter((x) => x && x.会话 && x.号码).length : 0
    const 实绑 = (洗好.绑定 || []).length
    记账(`设置已保存：绑定 ${实绑} 条${想绑 > 实绑 ? '（挡掉 ' + (想绑 - 实绑) + ' 条重复：同一间会话/同一个聊天只能绑一条）' : ''}｜${状态}`
      + (洗好.令牌 ? '｜带接口令牌' : ''))
    回(res, { ...(await 概况()), 说: '保存好了' })
  })

  // 收到 QQ 里你发来的话 → 喂进目标会话，让它照常开一轮。
  // ⚠ 这是「QQ → DSH」那半的**入口函数**：一句正文（+ 图）→ agent.followup 走 DSH 自己的回合。
  // ⭐ 2026-10-22：加了图片。图会先落一份到 `~/.dsh/qq-bridge-inbox/`，再把图交给 DSH 的
  //    attachments；模型能看图就直接看，纯文本模型拿到的是一句占位文字 —— 所以文字里也写上本地路径。
  // ── QQ 里的「分享卡片」和「合并转发的聊天记录」也读成文字（2026-10-25）──────────
  //   以前只认 text / image / mface ⇒ 她一发 B站 卡片、或者转发一段聊天记录，
  //   段里没有文字、也没有图，整条被当成「空消息」丢掉 —— 看着就是「QQ 桥读不了」。
  const 掐短 = (s2, n = 120) => {
    const t = String(s2 == null ? '' : s2).replace(/\s+/g, ' ').trim()
    return t.length > n ? t.slice(0, n) + '…' : t
  }
  const 反斜 = (t) => String(t || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  const 抽BV号 = (文) => {
    const m = /BV[0-9A-Za-z]{10}/.exec(String(文 || ''))
    return m ? m[0] : ''
  }
  /** 从分享卡片段（json / xml）里抽标题、描述、链接 —— 抽不到也给一句看得懂的话 */
  function 卡片文字(段) {
    const d = (段 && 段.data) || {}
    let 原 = d.data != null ? d.data : (d.content != null ? d.content : (d.xml != null ? d.xml : ''))
    if (原 && typeof 原 === 'object') 原 = JSON.stringify(原)
    原 = 反斜(String(原 || ''))
    const 题们 = []
    let 链接 = ''
    try {
      const j = JSON.parse(原)
      const 摸 = (o, 层 = 0) => {
        if (!o || typeof o !== 'object' || 层 > 6) return
        for (const [k, v] of Object.entries(o)) {
          if (typeof v === 'string') {
            const 值 = 反斜(v).trim()
            if (/^(title|desc|summary|prompt)$/i.test(k) && 值) 题们.push(值)
            if (/^(jumpUrl|qqdocurl|url)$/i.test(k) && /^https?:/i.test(值) && !链接) 链接 = 值
          } else 摸(v, 层 + 1)
        }
      }
      摸(j)
    } catch (e) { /* 不是 JSON 就按 xml 抓 */ }
    if (!题们.length || !链接) {
      const 标题 = /<title>([\s\S]{0,100}?)<\/title>/i.exec(原)
      if (标题 && 反斜(标题[1]).trim()) 题们.push(反斜(标题[1]).trim())
      const 摘要 = /<summary>([\s\S]{0,140}?)<\/summary>/i.exec(原)
      if (摘要 && 反斜(摘要[1]).trim()) 题们.push(反斜(摘要[1]).trim())
      const 链 = /(https?:\/\/[^\s"'<>&]+)/.exec(原)
      if (链 && !链接) 链接 = 链[1]
    }
    const 题 = [...new Set(题们)].slice(0, 2).join(' —— ')
    const bv = 抽BV号(原 + ' ' + 链接)
    const 尾 = [链接 ? '链接 ' + 链接 : '', bv ? 'BV号 ' + bv : ''].filter(Boolean).join('　')
    if (!题 && !尾) return '[分享卡片（里面没抓到内容）]'
    const 头 = bv ? '[分享视频卡片]' : '[分享卡片]'
    return 头 + ' ' + (题 || '（没标题）') + (尾 ? String.fromCharCode(10) + '  ' + 尾 : '')
  }
  /** 合并转发的聊天记录：拿 id 去 NapCat 取节点，压成几行 */
  /**
   * 合并转发的聊天记录：拿 id 去 NapCat 取节点，压成「一行一句」。
   * ⭐ 2026-10-25：分两层处理 —— **外层几句话就几行**，里面那层转发**另起一段、缩进一层**，
   *    不再把内层整段塞进同一行（上一版会挤成一大坨，人看着不直观）。
   *    一条转发里套好几个转发也照样各起一段。
   * 最多展开到层号 3；优先使用 QQ 已随消息传来的节点，再查询缺失内容。
   * 第一层里的图可以在「收图」开着时顺手收进来（第二层起只标 [图片]）。
   */
  async function 转发行们(段, 拉任意, 图袋, 层, 预算) {
    const 缩 = '  '.repeat(层 + 1)
    const d = (段 && 段.data) || {}
    const 内置 = Array.isArray(d.content) ? d.content : []
    const id = String(d.id ?? d.message_id ?? (typeof d.content === 'string' ? d.content : ''))
    if (!id && !内置.length) return [缩 + '[合并转发的聊天记录（没有 id，读不出来）]']
    let 节点们 = 内置
    if (!节点们.length) for (const 体 of [{ message_id: id }, { id }]) {
      try {
        const 结果 = await 拉任意('get_forward_msg', 体)
        const 候选 = (结果 && (结果.messages || 结果.message)) || null
        if (Array.isArray(候选) && 候选.length) { 节点们 = 候选; break }
      } catch { /* 兼容只接受另一种参数名的 OneBot 实现 */ }
    }
    if (!节点们.length) return [缩 + '[合并转发的聊天记录（内容取不到）]']
    const 行 = [缩 + '[合并转发的聊天记录 · 共 ' + 节点们.length + ' 条]']
    for (const 节 of 节点们.slice(0, 12)) {
      if (预算.行 <= 0) { 行.push(缩 + '  …（后面的没展开）'); break }
      预算.行--
      const 谁 = String((节 && 节.sender && (节.sender.card || 节.sender.nickname)) || (节 && 节.nickname) || '某人')
      const 段们 = Array.isArray(节 && 节.content) ? 节.content : (Array.isArray(节 && 节.message) ? 节.message : [])
      const 文本块 = []
      const 内层 = []
      for (const x of 段们) {
        if (!x) continue
        const 型 = String(x.type || '')
        if (型 === 'text') { 文本块.push(String((x.data && x.data.text) || '')); continue }
        if (型 === 'image' || 型 === 'mface') {
          // ⭐ 1.0.3（issue #13）：大表情（mface）不一定给 url —— 取不到就别让它整条消失，
          //    至少留一句「发了个什么表情」。普通图片照旧。
          const dd = (x.data || {})
          const 有图 = String(dd.url || dd.file || dd.path || dd.thumb || '')
          if (型 === 'mface' && !有图) {
            文本块.push('[表情:' + 掐短(String(dd.summary || dd.emoji_id || '大表情'), 20) + ']')
            continue
          }
          if (层 === 0 && Array.isArray(图袋)) 图袋.push(x)   // 只收第一层的图
          文本块.push('[图片]')
          continue
        }
        if (型 === 'face') { 文本块.push('[表情]'); continue }
        if (型 === 'record') { 文本块.push('[语音]'); continue }
        if (型 === 'video') { 文本块.push('[视频]'); continue }
        if (型 === 'json' || 型 === 'xml') { 文本块.push('[卡片]'); continue }
        if (型 === 'at') { 文本块.push('@' + String((x.data && (x.data.name || x.data.qq)) || '')); continue }
        if (型 === 'forward') { 内层.push(x); continue }
      }
      const 头 = 缩 + '  ' + 掐短(谁, 20) + '：'
      const 文本 = 文本块.join('').replace(/[ 	]+/g, ' ').replace(/[\r\n]+/g, ' ').trim()
      if (文本) 行.push(头 + 掐短(文本, 240))
      // 这个人的消息**只有一段转发**、没有别的话：也得让人看出是谁转的
      else if (内层.length && 层 === 0) 行.push(头 + '（转发的聊天记录）')
      for (const 内 of 内层) {
        if (层 >= 3) {
          // 太深了不再展开，但把「里层还有多少条」带出去 —— 别让人以为里面没内容
          预算.行--
          let 数 = 0
          try {
            const d2 = (内 && 内.data) || {}
            const id2 = String(d2.id ?? d2.message_id ?? (typeof d2.content === 'string' ? d2.content : ''))
            if (Array.isArray(d2.content) && d2.content.length) 数 = d2.content.length
            else if (id2) {
              const 结果2 = await 拉任意('get_forward_msg', { message_id: id2 })
              const 候选2 = (结果2 && (结果2.messages || 结果2.message)) || null
              if (Array.isArray(候选2)) 数 = 候选2.length
            }
          } catch (error) {}
          行.push(头 + (数 ? `[里面还有 ${数} 条转发，套得太深没展开]` : '[里面还套着一层转发（太深，没展开）]'))
          continue
        }
        行.push(...(await 转发行们(内, 拉任意, 图袋, 层 + 1, 预算)))
      }
      if (!文本 && !内层.length) 行.push(头 + '（这条没内容）')
    }
    return 行
  }

  /** 一条合并转发 → 整段文字（行数 / 字数都有上限，别把上下文吃光） */
  async function 转发文字(段, 拉任意, 图袋) {
    const 行们 = await 转发行们(段, 拉任意, 图袋, 0, { 行: 40 })
    let 文 = 行们.join(String.fromCharCode(10))
    if (文.length > 2500) 文 = 文.slice(0, 2500) + String.fromCharCode(10) + '…（太长，剩下的没展开）'
    return 文
  }

  async function 转入一条(文字, 图们, 消息id, 行, 发送者, 点名, 来源 = 'qq', 互动 = {}, purposeToken = null) {
    const 配置 = 读配置()
    // ⭐ 2026-10-25（0.6.0）：传「绑定行」进来 —— 每一行自带类型 / 号码 / 会话 / 称呼
    const 这条 = 行 || (配置.绑定 || [])[0] || null
    const 这间 = String((这条 && 这条.会话) || 配置.私聊会话 || '')
    if (!这间) return { ok: false, 说: '还没绑任何聊天（私聊或群）' }
    if(privateChat.blocksInput(这间)) return {ok:false,说:'私人网页回合尚未结束，QQ输入保留等待下一轮'}
    if (!配置.总开关) return { ok: false, 说: '总开关关着，先打开' }
    try { assertTrustedGroup(这条, 配置) }
    catch (error) { return { ok: false, 说: String(error?.message || '群隔离检查未通过') } }
    // ⭐ 会话没挂载也没关系：下面走本地 HTTP 的 session/prompt，它自己会把会话唤醒
    const agent = 找agent(这间)

    // ── 收图：限量、限重，失败就跳过，不挡住文字 ──
    const 收下 = []
    if (配置.收图 && Array.isArray(图们) && 图们.length) {
      const 上限 = Math.max(1, Math.min(Number(配置.收图最多) || 4, 10))
      const 最大 = Math.max(1, Math.min(Number(配置.图上限MB) || 5, 30)) * 1024 * 1024
      let 序 = 0
      for (const 段 of 图们.slice(0, 上限)) {
        序 += 1
        const buf = await 取图字节(段 && 段.data ? 段.data : 段)
        if (!buf || !buf.length) { 记账(`第 ${序} 张图下载失败，跳过`); continue }
        if (buf.length > 最大) { 记账(`第 ${序} 张图太大（${Math.round(buf.length / 1048576)}MB），跳过`); continue }
        const 类 = 看图类(buf)
        收下.push({ 类, b64: buf.toString('base64'), 存: 存一张(`${消息id || 'qq'}-${序}`, buf, 类), 字节: buf.length })
      }
    }

    const 原话 = String(文字 || '').trim()
    // 称呼跟着这一行走（群里不止一个人，别拿私聊的名字去叫）
    const 谁 = String((这条 && 这条.称呼) || ((这条 && 这条.类型 === '群') ? '群里的人' : '对方'))
    // ⭐ 1.0.3（issue #13）：有图但一张都没取到（大表情取不到 url / 格式不认识）→ 必须留句话，
    //    否则「没字也没图」会让整条消息被当成空的丢掉。
    const 试过几张 = Array.isArray(图们) ? Math.min(图们.length, Math.max(1, Math.min(Number(配置.收图最多) || 4, 10))) : 0
    const 挂了几张 = Math.max(0, 试过几张 - 收下.length)
    const 说明 = 收下.length
      ? String.fromCharCode(10) + '（' + 谁 + '发了 ' + 收下.length + ' 张图：'
        + 收下.map((x, i) => `第${i + 1}张 ${Math.round(x.字节 / 1024)}KB` + (x.存 ? `，要发回去就用 ${x.存}` : '')).join('；')
        + (挂了几张 ? `；另有 ${挂了几张} 张没取到` : '')
        + '）'
      : (试过几张
        ? String.fromCharCode(10) + '（' + 谁 + '发来 ' + 试过几张 + ' 张图，但一张都没取到 —— 多半是表情 / 格式不支持）'
        : '')
    // ⚠️ 2026-10-25（她报的）：群消息以前只有正文，**看不出是谁说的**。
    //    群里必须标清楚「昵称（QQ号）：」；私聊不用（就对面那一个人）。
    // 群里：主人的话单独标成「老哥：」，她才知道该对谁亲
    const 群发送者号 = String((发送者 && 发送者.号码) || '')
    const 主人号 = String(配置.主人号码 || '')
    const 是我主 = Boolean(主人号) && 群发送者号 === 主人号
    const 署名 = (这条 && 这条.类型 === '群' && 发送者 && (发送者.昵称 || 发送者.号码))
      ? (String(发送者.昵称 || '某人') + '（' + String(发送者.号码 || '?') + '）：')
      : ''
    const 基础 = (原话 ? 署名 + 原话 : (收下.length ? 署名 + '（' + 谁 + '发来了图片，没有配字）' : '')) + 说明
    if (!基础) return { ok: false, 说: '这条既没文字也没图，不转' }
    // ⭐ 这一行开了门槛时，顺手告诉它「先判断这条是不是在跟你说话」
    const 门槛提示 = 这条?.类型 === '群'
      ? (来源 === 'group-proactive' ? '\n\n（当前没有新群消息。这是本次活动机会的结束点：可直接分享一个独立话题，也可选择安静；调用 reply=false 后本次不再发送。不要继续模拟时间流逝、下一轮触发或群友回复；旧记录中的助手生成内容不代表群友说过的话。）' : 点名 ? '\n\n（这条群消息直接@、引用或叫了你的名字，是在找泡泡，优先留意，不要求对方额外@。仍可根据内容决定回答、简短拒绝或不回应；不想接话可用 qq_reply_gate 的 reply=false 并安静结束）' : '\n\n（群消息：没有叫你也可以参与，有意思的分享、玩笑或能补充的内容都可以自然接话。想说就直接输出给群友的正文，qq_reply_gate 是可选工具；不想接话可用 reply=false 并安静结束，不发送说明）')
      : ''
    // ⭐ 开了「只发 [QQ] 块」时，必须告诉它这个约定 —— 不然它压根不会写这个块，一开开关就一条都发不出去
    const 块提示 = 配置.只发标记内
      ? String.fromCharCode(10) + String.fromCharCode(10)
        + '（这台机器只把正文里 `[QQ]…[/QQ]` 中间那段发到 QQ —— 想让手机收到的就写在里面；'
        + '块外的话只在本机看，不会发出去。）'
      : ''
    const 群提示 = ''
    const 文案 = 基础 + 门槛提示 + 块提示 + 群提示

    let content = [{ type: 'text', text: 文案 }]
    if (收下.length) {
      const 附件 = ctx.attachments || ctx.get('attachments')
      if (附件 && typeof 附件.admitPromptContent === 'function') {
        try {
          const 入图 = await admitIncomingImages(ctx, {
            sessionId: 这间, kind: 这条?.类型, qq: String(这条?.号码 || ''), source: 来源, messageId: 消息id,
          }, 文案, 收下.map((x, i) => ({
            data: x.b64, mediaType: x.类, original: x.存, name: `qq-${消息id || 'x'}-${i + 1}.${扩展(x.类)}`,
          })))
          content = 入图.content
          // ⭐ 记下「附件 id / DSH 那份只读副本 → 我们存的原图」，回发时换回原图（GIF 不会变静态 webp）
          const 图块 = content.filter((x) => x && x.type === 'image' && x.attachment)
          for (let i = 0; i < 图块.length && i < 入图.originals.length; i++) {
            let 副本 = ''
            try { 副本 = typeof 附件.imageHostPath === 'function' ? String(附件.imageHostPath(图块[i].attachment) || '') : '' } catch (error) {}
            记收图(图块[i].attachment && 图块[i].attachment.attachmentId, 副本, 入图.originals[i])
          }
        } catch (error) {
          记账('图交给 DSH 没成功（这轮只转文字）：' + String((error && error.message) || error))
          content = [{ type: 'text', text: 文案 }]
        }
      } else {
        记账('宿主没有 attachments 服务，图只能存本地（文字里已经给了路径）')
      }
    }

    try {
      // ⭐ 记下「这一轮是谁在说话」：memory-long 等插件靠它判断该不该注入私密记忆
      try {
        const 主人号 = String((配置 && 配置.主人号码) || '')
        const 来者号 = String((这条 && 这条.号码) || '')
        const 是主人 = 这条?.类型 === '私聊' && 主人号 !== '' && 来者号 === 主人号
        const 哪位 = String((这条 && 这条.称呼) || (是主人 ? '老哥' : '客人'))
        writeFileSync(
          String(process.env.DSH_HOME || '/srv/dsh-cloud/home').replace(/\/$/, '') + '/.current-speaker.json',
          JSON.stringify({
            guest: !是主人,
            name: 哪位,
            qq: 来者号,
            known: 是主人 || 哪位 !== '客人',
            kind: String((这条 && 这条.类型) || '私聊'),
            at: Date.now(),
          }),
          'utf8',
        )
      } catch (error) {
        // 写不进去不影响收发
      }

      // ⚠⚠ 必须 await：followup 返回 Promise。不接住的话，它 reject 时（会话半死 / agent 已释放）
      //   catch 根本看不到（try 早就退出了）⇒ 未处理的 rejection ⇒ **整个 DSH 宿主退出**
      //   （2026-10-21：speak-up 同一个坑已经被用户报成"装了鱼就死了"，这里一并修）
assertTrustedGroup(这条, 读配置())
if(这条?.类型==='群') {
  const inputAt=Date.now()
  群输入证据.queue(会话键(这间),提取正文({content}),{source:来源,at:inputAt,directed:来源==='qq'&&Boolean(点名)})
  if(来源==='qq')群主动.observe(这条,inputAt,{directed:Boolean(点名),replyIds:互动.replyIds||[]})
}
if (agent && typeof agent.followup === 'function') {
        const message={ id: 新id(), role: 'user', content, source: { kind: 来源 } }
        const revokePurpose=purposeReceipts.register(这间,message,purposeToken)
        try{await agent.followup(message)}catch(error){revokePurpose();throw error}
      } else {
        // ⭐ 会话没开着：直接打本地 HTTP 的 session/prompt（它会把会话唤醒再跑一轮）
        if(purposeToken)purpose.settle(purposeToken,'cancelled')
        await 走HTTP投递(这间, content)
      }
      // ⭐ 0.9.9：记「哪个聊天、什么类型、有没有点名」—— 门槛和外发都要用
      唤醒时间.set(会话键(这间), {
        时: Date.now(),
        类型: String((这条 && 这条.类型) || '私聊'),
        点名: Boolean(点名),
      })
      try {
        if (ctx.sessions && typeof ctx.sessions.flush === 'function') await ctx.sessions.flush(agent.session)
      } catch (error) {}
      const 图话 = 收下.length ? `（含 ${收下.length} 张图）` : ''
      记账(`收到 QQ 里的${收下.length ? '图片' : '话'}${图话} → 转进 DSH：「${(原话 || '（没配字）').slice(0, 50)}${原话.length > 50 ? '…' : ''}」`)
      return { ok: true, 说: '转进去了，它会照常开一轮' }
    } catch (error) {
      return { ok: false, 说: `followup 失败：${String((error && error.message) || error)}` }
    }
  }

  /** 只要文字的那条老入口（给 /receive 路由和测试用） */
  async function 转入文字(文字) {
    return 转入一条(文字, [], '')
  }

  // ── 回复门槛（2026-10-25）─────────────────────────────────────────
  //  口径（她定的）：**消息照常进来、照常叫醒**；判断放在"思考的时候" ——
  //  模型调 `qq_reply_gate` 看这条是不是在跟它说话：
  //    · reply = true  → 正常接话；
  //    · reply = false → 工具成功后正常结束本轮，不额外请求模型。
  //  出站仍检查本会话、本轮的群判定；正常结束不代表允许发言。
  //  ⚠️ 工具只在「被 QQ 叫醒后的一小段时间内」有效 —— 她自己在 DSH 界面上聊天时，
  //     模型就算想关闸也关不掉（避免把自己的一轮聊没了）。
  // ⚠️ 2026-10-25：以前是**全局一个时间戳** —— A 群刚被 QQ 叫醒，B 群这轮也会被当成「QQ 叫的」。
  //    现在按会话记：哪个聊天叫醒的，只有那一间算。
  // ⭐ 0.9.9：唤醒信息从「一个时间戳」升级成 { 时, 类型, 点名 }
  //   —— 因为门槛要能分辨「这轮是私聊还是群」「有没有人 @ 我 / 引用我」
  const 唤醒时间 = new Map()   // 会话键 -> { 时, 类型: '私聊'|'群', 点名: boolean }
  // ⭐ 1.0.1：唤醒消费掉之后留一条「尾巴」——同一次 QQ 触发的后续轮次还算 QQ 起的头
  const 尾巴 = new Map()       // 会话键 -> 到什么时候（毫秒时间戳）
  const 己方消息 = new Set()   // 自己发出去的 message_id（认「引用了我」用）
  let 自己QQ = ''

  const 记己方消息 = (id) => {
    己方消息.add(String(id))
    if (己方消息.size > 800) 己方消息.clear()
  }

  /** 机器人自己的 QQ 号：拿一次记着（判断「@ 的是不是我」） */
  const 拿自己QQ = async (配置) => {
    if (自己QQ) return 自己QQ
    try {
      const r = await requestChannel(配置,'get_login_info', {
        method: 'POST', headers: 请求头(配置), body: '{}', signal: AbortSignal.timeout(8000),
      })
      const j = await r.json()
      if (j && j.status === 'ok' && j.data && j.data.user_id) 自己QQ = String(j.data.user_id)
    } catch (error) {}
    return 自己QQ
  }
  // ⚠️ 2026-10-25（她在手机上实测）：以前用 agent.cancel() 停轮 —— 结果是
  //    「工具调用 · Error: tool call aborted」+ 宿主开始「重试模型请求 (1/5)」，看着像坏了。
  //    现在使用 concludeTurn 正常结束，并在出站处按本轮判定跳过发送。
  const 静默轮 = new Set()     // 会话键
  const 闸门挂着 = new Map()   // sid -> disposer（DSH 的 tools.register 返回的就是一个收尾函数）
  const QqWalake窗口 = 10 * 60 * 1000

  const 文档入口 = createDocuments({home:目录,readConfig:读配置})
  const documentOff = ctx.tools.register(文档入口.tool)
  ctx.on('dispose',()=>{if(typeof documentOff==='function')documentOff()})
  const cardOff = ctx.tools.register(makeSelfGroupCard({readConfig:读配置,requestHeaders:请求头}))
  ctx.on('dispose',()=>{if(typeof cardOff==='function')cardOff()})
  const 群判定 = new Map()
  const 群输入证据 = createInputEvidence()
  const gateOff = ctx.tools.register({
    name: 'qq_reply_gate',
    description: '可选的群聊发言选择工具。根据话题、称呼、上下文和插话价值自行判断；没有点名也可以直接回复，不要求先调用本工具。reply=false 时安静结束，reply=true 后说给群友听的话。不向群友解释判定。',
    parameters: {type:'object',properties:{reply:{type:'boolean'},reason:{type:'string'},respondingToPaopao:{type:'boolean',description:'仅当这轮群友确实接着泡泡的话题或回答泡泡时为true；群里一般聊天、机器人主动开场不算'}},required:['reply'],additionalProperties:false},
    output: {schema:{type:'object',properties:{},additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},
    async execute(args, exec) {
      const sid = 会话键(exec?.agent?.session?.header?.id || exec?.agent?.session?.id || exec?.agent?.id)
      const conf = 读配置()
      const row = (conf.绑定 || []).find(x=>x.类型==='群' && 会话键(x.会话)===sid)
      if (!row) throw new Error('Only a registered group may decide its own reply')
      assertTrustedGroup(row, conf)
      const decision = 群判定.get(sid)
      if (!decision || decision.turn == null) throw new Error('No active group turn')
      if (typeof args?.reply !== 'boolean') throw new Error('reply must be boolean')
      decideGroupReply(decision,args.reply)
      if(decision.reply && args.respondingToPaopao===true && decision.input?.source==='qq')群主动.acknowledge(row,decision.input.at)
      // Successful silence completes the step; never abort an executing tool.
      // The native loop still drains fresh steering/additional contexts.
      if (!decision.reply) exec.concludeTurn()
      return {ok:true,reply:decision.reply,next:decision.reply?'只输出你选择说给群友的正文':'安静结束，不输出正文或说明'}
    },
  })
  ctx.on('dispose',()=>{if(typeof gateOff==='function')gateOff();群判定.clear();群输入证据.clear()})
  function 闸门心跳() {} // Gate is registered once, including before a session is mounted.

  // ⭐ 1.0.2：有攒着等的那一批时，别干等下一跳（4 秒）—— 快跑一跳把它发出去。
  //   最坏情况：撞上轮询时最后一条还新鲜（< 合并窗口秒）→ 1 秒后补跑 → 大约 1.5 秒落地。
  let 补跑定时 = null
  const 快跑一次 = (毫秒 = 1200) => {
    if (process.env.QQ_BRIDGE_不加速 === '1') return      // 自测用：别让定时器插进来
    if (补跑定时) return
    补跑定时 = setTimeout(() => {
      补跑定时 = null
      void 轮询收消息().catch(() => {})
    }, Math.max(300, 毫秒))
    try { if (typeof 补跑定时.unref === 'function') 补跑定时.unref() } catch (error) {}
  }

  /**
   * 轮询 NapCat 的 HTTP 历史接口，把「她新发的私聊 / 群消息」一条条转进 DSH。
   * ⚠ 纯 HTTP 轮询：不连 WebSocket、不依赖 BOT。
   * ⚠ 只认 `私聊QQ` 这个人发的（群也一样按这个号过滤），自己的回话不会自我繁殖。
   */
  /** 新号码自动分房：把还没登记的 QQ 好友塞进 guest-pool.json 里的空房间 */
  const 自动建群 = createGroupOnboarding(ctx,读配置)
  const 群主动 = createGroupProactive({readConfig:读配置,
    getAgent:sid=>找agent(sid),
    canStart:async()=>Boolean((await qqHealth.check(读配置())).ready),
    isBusy:sid=>{const a=找agent(sid);return a?.status!==undefined && a.status!=='idle'},
    start:(row,text,token)=>转入一条(text,[],'',row,undefined,false,'group-proactive',{},token),
  })
  async function 拉基础(action,配置) {
    const response=await requestChannel(配置,action,{method:'POST',headers:请求头(配置),body:'{}',signal:AbortSignal.timeout(8000)})
    if(!response.ok)throw new Error('QQ metadata unavailable')
    const result=await response.json()
    if(result.status!=='ok' || result.retcode!==0)throw new Error('QQ metadata failed')
    return result.data
  }
  async function 自动接客(配置) {
    const home=String(process.env.DSH_HOME || '/srv/dsh-cloud/home')
    const pool=readObject(join(home,'guest-pool.json'),{sessions:[]})
    if(!pool.sessions?.length || !配置.主人号码)return
    const friends=await 拉基础('get_friend_list',配置)
    const self=await 拉基础('get_login_info',配置)
    const file=join(home,'guests.json'),guests=readObject(file)
    const seals=readObject(join(home,'group-session-seals.json'),{sessions:{}})
    const reserved={...配置,绑定:[...(配置.绑定||[]),...Object.keys(seals.sessions||{}).map(sid=>({类型:'群',会话:sid}))]}
    const result=allocateGuests(pool,guests,friends,reserved,self?.user_id)
    if(result.added)saveGuests(file,result.guests)
  }
  let 上次发现=0,上次群主动=0
  const ownerWarmup=createOwnerWarmup(ctx,读配置)
  const 轮询状态={runs:0,errors:0,inFlight:false,lastStartedAt:null,lastFinishedAt:null,discoveryErrors:0}
  const 轮询收消息=singleFlight(async()=>{
    轮询状态.inFlight=true;轮询状态.runs++;轮询状态.lastStartedAt=Date.now()
    try {await ownerWarmup.run();await 执行轮询();if(Date.now()-上次群主动>=30000){上次群主动=Date.now();await 群主动.tick()}}
    catch(e){轮询状态.errors++;throw e}
    finally{轮询状态.inFlight=false;轮询状态.lastFinishedAt=Date.now()}
  })
  async function 执行轮询() {
    let 配置 = 读配置()
    if(配置.总开关){
      const before=qqHealth.status().status,channel=await qqHealth.check(配置)
      if(before!==channel.status)记账('QQ 连接状态：'+channel.explanation)
      if(!channel.ready){轮询状态.channelBlocked=(轮询状态.channelBlocked||0)+1;return}
    }
    if(配置.总开关 && !配置.试运行 && Date.now()-上次发现>=60000){
      上次发现=Date.now()
      if(配置.自动接群)try{await 自动建群.sync(await 拉基础('get_group_list',配置))}catch{轮询状态.discoveryErrors++}
      if(配置.自动接客)try{await 自动接客(配置)}catch{轮询状态.discoveryErrors++}
      配置=读配置()
    }
    // 总开关关 / 一条绑定都没有：只把「上次时间」推到此刻，别开的时候就补一大串旧的
    if (!配置.总开关 || !(配置.绑定 || []).length) {
      for (const k of [...上次时间.keys()]) 上次时间.set(k, Math.floor(Date.now() / 1000))
      return
    }
    // 群里只认「私聊那行绑的那个号」（就是你自己）；没绑私聊行的话，群里谁的话都不转
    const 机器人号 = await 拿自己QQ(配置)

    const 拉 = async (action, 体) => {
      try {
        const r = await requestChannel(配置,action, {
          method: 'POST', headers: 请求头(配置), body: JSON.stringify(体), signal: AbortSignal.timeout(8000),
        })
        const j = await r.json()
        if(!r.ok||j?.status!=='ok'||!Array.isArray(j.data?.messages))throw Error('QQ history unavailable')
        return j.data.messages
      } catch (error) {
        轮询状态.historyErrors=(轮询状态.historyErrors||0)+1
        轮询状态.lastHistoryErrorAt=Date.now()
        return []
      }
    }
    // ⭐ 拉任意一个 NapCat 接口（合并转发要单独取一次内容；它的返回不是 data.messages 那种形状）
    const 拉任意 = async (action, 体) => {
      try {
        const r = await requestChannel(配置,action, {
          method: 'POST', headers: 请求头(配置), body: JSON.stringify(体 || {}), signal: AbortSignal.timeout(8000),
        })
        const j = await r.json()
        return (j && j.status === 'ok' && j.data) || null
      } catch (error) {
        return null
      }
    }
    // ⚠️ 2026-10-25（用户报「读不了 B站 卡片 / 转发记录」）：以前这里只看 text / image / mface，
    //    卡片和合并转发既没文字也没图 ⇒ 整条被当成空消息丢掉。现在它们也会变成文字。
    const 收图上限 = () => Math.max(1, Math.min(Number(配置.收图最多) || 4, 10))
    const 条转片段 = async (条, 文件行) => {
      let 文档数 = 0
      const 段们 = Array.isArray(条.message) ? 条.message : []
      const 图们 = []
      const 文们 = []
      const replyIds=[]
      let 点名 = false          // ⭐ 0.9.9：这条是不是点了我的名（@ 我 / 引用我的消息）
      const 我 = await 拿自己QQ(配置)
      for (const 段 of 段们) {
        if (!段 || !段.data) continue
        const 型 = String(段.type || '')
        if (型 === 'at') {
          const at谁 = String(段.data.qq || '')
          if (我 && at谁 === 我) 点名 = true          // at全体（qq='all'）不算点名
          if (!我 || at谁 !== 我) 文们.push('@' + String((段.data && (段.data.name || 段.data.qq)) || ''))
          else 文们.push('@' + String((段.data && (段.data.name || '你')) || '你'))
          continue
        }
        if (型 === 'reply') {
          const 被引 = String(段.data.id || '')
          if(被引)replyIds.push(被引)
          if (被引 && 己方消息.has(被引)) 点名 = true   // 引用的是我发的 → 就是冲我来的
          文们.push('[引用了一条消息]')
          continue
        }
        if (型 === 'text') { 文们.push(String(段.data.text || '')); continue }
        if (型 === 'file') {
          if (++文档数 > 2) { 文们.push('[文件：每条消息最多读取两份文档，请分开发送]'); continue }
          文们.push(await 文档入口.ingest(段, 文件行, String(条.message_id || 条.message_seq || ''), 拉任意))
          continue
        }
        if (型 === 'image' || 型 === 'mface') {
          // ⭐ 1.0.3（issue #13）：大表情的字段和普通图不一样（emoji_id / key），很多根本没有 url。
          //    取不到可下载地址时至少留一句，别让整条消息变成「空的」被丢掉。
          const dd = (段.data || {})
          const 有图 = String(dd.url || dd.file || dd.path || dd.thumb || '')
          if (型 === 'mface' && !有图) {
            文们.push('[表情:' + 掐短(String(dd.summary || dd.emoji_id || '大表情'), 20) + ']')
            continue
          }
          图们.push(段);
          continue
        }
        if (型 === 'json' || 型 === 'xml') { 文们.push(卡片文字(段)); continue }
        if (型 === 'forward') {
          // ⭐ 转发里的图**跟着「收图」这个开关走**（不另加开关）：开着收几张，关着只标 [图片]
          const 袋 = 配置.收图 ? [] : null
          try {
            const 文 = await 转发文字(段, 拉任意, 袋)
            文们.push(文)
            if (Array.isArray(袋) && 袋.length) {
              const 余量 = Math.max(0, 收图上限() - 图们.length)
              for (const x of 袋.slice(0, 余量)) 图们.push(x)
            }
          } catch (error) { 文们.push('[合并转发的聊天记录（读失败了）]') }
          continue
        }
        if (型 === 'face') { 文们.push('[表情]'); continue }
        if (型 === 'record') {
          // ⭐ 0.8.0：开着「语音转写」且配了命令 → 把语音条变成文字；否则还是 [语音]
          文们.push(await 转写语音(段, 拉任意, 配置, {
            家目录: dirname(配置文件), ffmpeg: await 找ffmpeg(), 消息id: 条.message_id,
          }))
          continue
        }
        if (型 === 'video') { 文们.push('[视频]'); continue }
      }
      // 用同一份判定再兜一遍（免得以后两边规则走散）
      点名 = 点名 || 识别点名(段们, 我, 己方消息)
      if(文件行?.类型==='群')点名 = 点名 || callsPaopao(段们.filter(s=>s?.type==='text').map(s=>s.data?.text||'').join(''),条.user_id,配置.主人号码)
      return { 文字: 文们.join(String.fromCharCode(10)).trim(), 图们, 点名, replyIds }
    }

    // ⭐ 0.6.0：一行一行地拉 —— 一个聊天 → 一间会话，各自记各自的「看到哪儿了」
    for (const 行 of 配置.绑定) {
      const 是群 = 行.类型 === '群'
      const 动作 = 是群 ? 'get_group_msg_history' : 'get_friend_msg_history'
      const 体 = 是群
        ? { group_id: Number(行.号码), count: 30 }
        : { user_id: Number(行.号码), count: 10 }
      const 列表 = await 拉(动作, 体)
      const 键2 = 行.类型 + ':' + 行.号码
      // ⚠️ 没记录过这个聊天（比如刚加绑定 / 第一次跑）时，从**此刻**开始算 ——
      //   否则历史消息会全被当成新的补投一遍（她报的那个「没发消息却自己回了」就有这一层）。
      let 上次 = 上次时间.has(键2) ? (上次时间.get(键2) || 0) : Math.floor(Date.now() / 1000)

      // ⭐ 1.0.2：这一个聊天里「攒着还没转进去」的一批（同一个人连着发的）
      let 攒 = null
      /** 把这批转进去；返回 false = 还在等人说完（或这轮没转成），调用方别推进水位 */
      const 落袋 = async (force=false) => {
        if (!攒) return true
        const 窗口 = 是群 ? 3 : Number(配置.合并窗口秒) || 0
        const 现在秒 = Math.floor(Date.now() / 1000)
        const 最长 = 是群 ? 8 : Number(配置.合并最多秒) || 20
        const 差 = 现在秒 - (攒.末 || 0)
        // 差 < 0 说明是「未来的时间戳」（时钟歪了 / 老测试造的），别傻等
        if (!force && 窗口 > 0 && 差 >= 0 && 差 < 窗口 && (现在秒 - 攒.起) < 最长) {
          快跑一次(Math.max(300, Math.round(窗口 * 1000) + 200))
          return false      // 最后一条刚过去没多久 —— 再等等，下一跳连新的那条一起收
        }
        const 一批 = 攒
        攒 = null
        const 文字 = 是群 ? renderGroupBurst(一批.messages) : 一批.文字们.filter(Boolean).join(String.fromCharCode(10))
        if (一批.ids.length > 1) 记账('连着发的 ' + 一批.ids.length + ' 条攒成一条转进去')
        const 结果 = await 转入一条(文字, 一批.图们, 一批.ids[0], 行, 是群?undefined:一批.发送者, 一批.点名, 'qq', {replyIds:一批.replyIds})
        if (结果 && 结果.ok) {
          for (const id of 一批.ids) 已转消息.add(id)
          上次 = Math.max(上次, 一批.末 || 上次)
          return true
        }
        记账('这条先没转进去（' + 短id(行.会话) + '：' + String((结果 && 结果.说) || '原因不明') + '），下一跳再试')
        return false
      }
      for (const 条 of 列表.sort((a, b) => (a.time || 0) - (b.time || 0))) {
        if (!条) continue
        // 私聊：只认对面那个号；群：只认你自己—— 别人的话不转（防噪音，也防被别人的话牵着走）
        if (!是群) {
          // 私聊：只认对面那个号
          if (String(条.user_id) !== String(行.号码)) continue
        } else {
          // ⭐ 0.9.9（别处报的「群里 @ 大肥鱼 不理人」）：群里以前**只收她自己发的**，
          //    别人 @ 它、引用它的消息**根本没转进来**（连门槛都没机会判）。
          //    现在：别人的消息**只要点了名（@ 我 / 引用我）就收**；想收全群的话把
          //    「群里也听别人的话」打开。
          if (!机器人号) continue // Fail closed until bot identity is confirmed
          const 自己的 = String(条.user_id) === 机器人号
          // ⭐ 自己发的话绝对不能再转进来（否则自问自答）
          if (自己的) continue
          {
            if (!配置.群里听所有人) {
              const 试 = await 条转片段(条, 行)
              if (!试.点名) continue
            }
          }
        }
        if ((条.time || 0) < 上次) continue           // 旧的，跳过
        if (已转消息.has(条.message_id)) continue     // 转过了
        const { 文字, 图们, 点名, replyIds } = await 条转片段(条, 行)
        // 纯表情（没图没字）就别转了，记掉别再反复拉
        if (!文字 && !图们.length) { 已转消息.add(条.message_id); 上次 = 条.time || 上次; continue }
        // ⚠️ 2026-10-25（她问的）：那间会话要是**当时没开着**（死的），这条不能算「转过了」——
        //   否则她一会儿把它点活了，这条就永远丢了（还不会补）。
        //   所以：**真转进去了**才算数；没转进去就不动「上次」和「已转」，下一跳（4 秒后）自己再来一遍。
        // ⚠️ 2026-10-25（她报的「打开会话就被自动回一条」）：会话关着的时候攒下的旧消息，
        //    隔太久（默认 10 分钟）就别补投了 —— 否则她一点进那间屋，就会突然冒出一条「自动回复」。
        const 太旧 = (条.time || 0) > 0 && (Math.floor(Date.now() / 1000) - 条.time) > (Number(配置.补投窗口分) || 10) * 60
        if (太旧) {
          已转消息.add(条.message_id)
          上次 = 条.time || 上次
          记账('这条 QQ 消息已经是 ' + Math.round((Date.now() / 1000 - 条.time) / 60) + ' 分钟前的了，不再补投（怕一打开会话就冒出一条旧回复）')
          continue
        }
        const 发送者 = {
          昵称: String((条.sender && (条.sender.card || 条.sender.nickname)) || 条.nickname || (条.user_id ? 'QQ ' + 条.user_id : '')),
          号码: Number(条.user_id) || 0,
        }
        // ⭐ 1.0.2：连着的几条攒一起转（发一串图就不会一张一张回了）
        if (flushBefore(攒,{sender:发送者.号码,text:文字,time:条.time||0},是群)) {
          const 好 = await 落袋(true)
          if (!好) break
        }
        if (!攒) {
          攒 = {
            文字们: [], 图们: [], ids: [], replyIds:[], messages:[], 点名: false, 发送者,
            起: 条.time || 0, 末: 条.time || 0,
          }
        }
        攒.文字们.push(文字)
        攒.messages.push({sender:发送者.号码,name:发送者.昵称,id:条.message_id,text:文字,replyIds})
        if (图们.length) 攒.图们.push(...图们)
        攒.ids.push(条.message_id)
        攒.replyIds.push(...replyIds)
        攒.点名 = 攒.点名 || Boolean(点名)
        攒.末 = 条.time || 攒.末
        if (!是群 && !(Number(配置.合并窗口秒) > 0)) {
          const 好 = await 落袋()
          if (!好) break
        }
      }
      {
        const 好 = await 落袋()
        if (!好 && 攒) {
          // 还在等对方说完 —— 这一行这次就先不推进水位，下一跳连新的一起收
          上次时间.set(键2, 上次)
          continue
        }
      }
      上次时间.set(键2, 上次)
    }

    if (已转消息.size > 300) {
      // 别 clear（clear 会让下一跳把旧的又当新的）—— 只留最近 300 个
      const 全 = [...已转消息]
      for (const id of 全.slice(0, Math.max(0, 全.length - 300))) 已转消息.delete(id)
    }
    存水位()
  }

  路线(`${路由前缀}/architecture-state`,async(_req,res)=>回(res,{
    ok:true,version:'architecture-v1',replyDelivery:'ordered-turn-v2',conversationQuality:'v1',mentionReplyFix:true,ownerWarmup:ownerWarmup.status(),poll:{...轮询状态},watermarks:{restored:上次时间.size,deduplicated:已转消息.size,readError:水位读错,writeError:水位写错},
    groups:自动建群.status(),groupProactive:群主动.status(),channel:readChannelHealth(),privateActivity:privateActivity.read(),activityDecision:'conversation-scoped-v2',purpose:purposeOverview(读配置()),
    integrity:verifyManaged(join(dirname(配置文件),'managed-runtime-manifest.json')),
  }))
  路线(`${路由前缀}/receive`, async (req, res) => {
    const 来 = await 读体(req)
    const 文字 = typeof 来.text === 'string' ? 来.text.trim() : ''
    if (!文字) return 回(res, { ok: false, 说: '没有文字（body 里给 text）' })
    回(res, await 转入文字(文字))
  })

  // 调试：看看桥自己能不能换到 cookie
  路线(`${路由前缀}/token-test`, async (req, res) => {
    const info = 本机服务信息()
    const out = { tokenConfigured: Boolean(info.token), cookieReady: false, port: info.port }
    try {
      _cookie.v = ''
      _cookie.at = 0
      out.cookieReady = Boolean(await 取cookie())
      out.ok = true
    } catch (error) {
      out.ok = false
      out.error = 'Local authentication check failed'
    }
    return 回(res, out)
  })
  // 调试：往指定会话投一句话（验证客人房间能不能收）
  路线(`${路由前缀}/receive-to`, async (req, res) => {
    const 来 = await 读体(req)
    const sid = String(来.session || '').trim()
    const 文字 = typeof 来.text === 'string' ? 来.text.trim() : ''
    if (!sid || !文字) return 回(res, { ok: false, 说: '要给 session 和 text' })
    const 行 = (读配置().绑定 || []).find(b => b.会话 === sid)
    if (!行 || (来.qq && String(来.qq) !== String(行.号码))) return 回(res, { ok: false, 说: '只能向已绑定且身份一致的聊天投递' })
    const 结果 = await 转入一条(文字, [], '', 行)
    return 回(res, 结果)
  })
  // 手动试一发：**真发**（绕过试运行），只发一条固定测试句，动不了已发轮
  路线(`${路由前缀}/test-send`, async (req, res) => {
    const 来 = await 读体(req)
    const 配置 = 读配置()
    const 绑定 = 配置.绑定 || []
    if (!绑定.length) {
      return 回(res, { ok: false, 说: '还没绑定任何聊天 —— 去「绑定」页加一条（一行 = 一个聊天 → 一间会话）' })
    }
    // 0.9.7：体里指定了哪条就发哪条，没指定就发第一条；一律按绑定发（不再看老字段 私聊QQ/群号）
    const 选 = 绑定.find((b) => 会话键(b.会话) === 会话键(来.会话)) || 绑定[0]
    const 谁 = (选.类型 === '群' ? '群 ' : '私聊 ') + 选.号码
    const 文字 = '（这是一条测试消息：DSH → QQ 通了）'
    const 结果 = await 发到QQ(配置, 文字, [], 选.会话)
    const 全过 = 结果.length > 0 && 结果.every((r) => r.ok)
    记账(`手动测试（发给 ${谁}）：${全过 ? '✅ 已发' : '⚠ 有问题'}「${文字}」`)
    for (const r of 结果) if (!r.ok) 记账(`   ${r.action} 失败：${JSON.stringify(r.数据).slice(0, 140)}`)
    回(res, {
      ok: 全过,
      说: 全过 ? ('测试句已经发到 ' + 谁 + ' 了') : ('发给 ' + 谁 + ' 时没发出去（看下面的记录）'),
      记录: 日志,
    })
  })

  // ---------- 挂监听 ----------

  ctx.effect(() => {
    const 摘 = ctx.on('session/event', (session, event) => {
      try {
        收到事件(session, event)
      } catch (error) {
        记账(`转发时出错：${String((error && error.message) || error)}`)
      }
    })
    return () => {
      try {
        if (typeof 摘 === 'function') 摘()
      } catch (error) {}
    }
  }, 'qq-bridge: 盯伙伴说话')

  // 轮询 NapCat 收「她新发的 QQ」→ 转进 DSH（QQ → DSH 这半，不赖 BOT）
  ctx.effect(() => {
    if (typeof ctx.interval !== 'function') {
      记账('拿不到 timer（ctx.interval 不在）—— QQ → DSH 的轮询收消息跑不起来，但 DSH → QQ 照常能用')
      return () => {}
    }
    const 停 = ctx.interval(() => {
      闸门心跳()
      void 轮询收消息().catch((error) => {
        try { ctx.logger?.info(`qq-bridge: 轮询出错：${String((error && error.message) || error)}`) } catch (e2) {}
      })
    }, 读配置().轮询间隔毫秒)
    return () => {
      try {
        if (typeof 停 === 'function') 停()
      } catch (error) {}
    }
  }, 'qq-bridge: 轮询收 QQ 消息')

  记账(`已装好 v${版本}：DSH↔QQ 两半都在｜总开关 ${读配置().总开关 ? '开' : '关'}｜试运行 ${读配置().试运行 ? '开（只记账）' : '关（真发）'}｜收消息 ${读配置().轮询间隔毫秒} 毫秒轮询一次`)

  // ---------- 自测用的小钩子（只造状态，不改行为） ----------
  const 测试 = {
    轮询:轮询收消息,
    记群输入:(sid,text,directed,source='qq')=>群输入证据.queue(会话键(sid),text,{directed,source}),
    水位:()=>({上次:Object.fromEntries(上次时间),已转:[...已转消息]}),
    记唤醒: (会话, 类型, 点名) => 唤醒时间.set(会话键(会话), { 时: Date.now(), 类型: String(类型 || '群'), 点名: Boolean(点名) }),
    清唤醒: (会话) => 唤醒时间.delete(会话键(会话)),
    清尾巴: (会话) => 尾巴.delete(会话键(会话)),
    有尾巴: (会话) => Boolean((尾巴.get(会话键(会话)) || 0) > Date.now()),
    记己方: (id) => 记己方消息(id),
    己方数量: () => 己方消息.size,
  }

  return { 记账, 概况, 落地一发, 发到QQ, 收到事件, 日志, 测试 }
}
