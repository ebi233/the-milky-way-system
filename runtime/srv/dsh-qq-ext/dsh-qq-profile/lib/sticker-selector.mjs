import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const groups = {
  joy: ['开心', '快乐', '高兴', '欢呼', '好耶', '庆祝', '雀跃'],
  laugh: ['好笑', '哈哈', '笑死', '大笑', '偷笑', '偷乐', '捂嘴笑', '笑出声'],
  comfort: ['抱抱', '拥抱', '摸头', '摸摸头', '安慰', '拍拍', '抱住', '不哭'],
  affection: ['喜欢你', '想你', '想老哥', '贴贴', '蹭蹭', '撒娇', '亲亲', '爱你', '黏人'],
  shy: ['害羞', '脸红', '不好意思', '羞涩'],
  praise: ['夸夸', '夸奖', '夸赞', '厉害', '点赞', '真棒', '不愧是你'],
  food: ['吃白饭', '干饭', '吃饭', '肚子饿', '饿了', '蹭饭', '要饭', '没吃饱'],
  sleepy: ['困了', '犯困', '困困', '打哈欠', '困倦'],
  goodnight: ['晚安', '好梦', '睡觉去', '睡啦'],
  tired: ['累了', '好累', '疲惫', '瘫着', '躺平', '没力气'],
  greeting: ['早安', '早上好', '早呀', '你好', '打招呼', '哈罗', 'ciallo'],
  puzzled: ['疑惑', '困惑', '问号', '不懂', '迷惑', '歪头'],
  surprise: ['震惊', '惊讶', '惊呆', '吓一跳', '目瞪口呆'],
  sad: ['难过', '伤心', '委屈', '落泪', '哭哭', '呜呜'],
  apology: ['对不起', '抱歉', '认错', '道歉'],
  agreement: ['同意', '赞成', '点头', '赞同'],
  playful: ['得意', '哼哼', '略略略', '调皮', '吐舌', '耍赖', '鬼脸'],
}
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().trim()
const tagsOf = text => new Set(Object.entries(groups).filter(([, words]) => words.some(w => text.includes(w))).map(([tag]) => tag))
const harsh = /嘲讽|讽刺|嫌弃|鄙视|嘲笑|不耐烦|滚开|滚出去|别烦|闭嘴|去死|蠢货|废物|垃圾|跪下|飞踹|踹飞|揍你|打死|扇巴掌|瞧不起|杂鱼|笑点真低|那你走|别来找|不想理你/
const serious = /认真(?:说|聊|听)|说(?:点|句)?心里话|难过|伤心|委屈|崩溃|绝望|失恋|失业|去世|离世|生病|不舒服|不想活|活不下去|自杀|自残|很痛苦|真的很累|好累|想哭|别开玩笑|你(?:都)?不理我|你很冷漠|心情不好|不开心|不高兴|很烦躁/
const asksSticker = /斗图|(?:发|给|来|想看|换).{0,12}(?:表情包|表情|梗图|贴纸)|(?:表情包|梗图|贴纸).{0,8}(?:发|来|看看)/
const refusesSticker = /(?:别|不要|不想|不许|停止).{0,8}(?:发表情|发图|表情包|梗图|贴纸)|(?:表情包|梗图).{0,6}(?:别发|不要发)/
const discomfort = /不喜欢|讨厌|别再发|不要再发|不想看|不好看|看不懂|没意思|别用这|换一张|不可爱|不好笑|不贴切|不合适/
const pleased = /喜欢|可爱|好看|好笑|有意思|好喜欢|太贴切|很贴切|喜欢这张/

export function conversationTurn(session) {
  try {
    const events = session?.snapshotEvents?.() || []
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i], data = e?.data || e?.payload
      if (e?.type !== 'user/message' || !['qq', 'user'].includes(data?.source?.kind)) continue
      let text = (data.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n')
      if (text.startsWith('【本群连续消息】')) {
        try { const rows = JSON.parse(text.split('\n')[1]); text = rows.map(r => String(r.text || '')).join('\n'); } catch { text = ''; }
      }
      text = text.slice(-2500)
      return { text, id: String(data.id || e.seq || e.time || createHash('sha256').update(text).digest('hex')), at: Number(e.time || 0) }
    }
  } catch { /* Unknown context must not authorize an automatic sticker. */ }
  return { text: '', id: '', at: 0 }
}

export function feedback(peer, turn, now) {
  const last = peer.recent?.at(-1)
  if (!last || !turn.id || peer.feedbackId === turn.id || now - last.at > 10 * 60000 || turn.at < last.at) return
  // Only explicit references to the last picture count as preference evidence.
  if (!/这张|这个表情|刚才.{0,8}(?:图|表情)|表情包|梗图/.test(turn.text)) return
  const text = normalize(turn.text)
  peer.avoided ||= {}; peer.likes ||= {}
  if (discomfort.test(text) || refusesSticker.test(text)) peer.avoided[last.id] = true
  else if (pleased.test(text)) peer.likes[last.id] = Math.min(5, (peer.likes[last.id] || 0) + 1)
  peer.feedbackId = turn.id
}

export function chooseSticker(index, { keyword, intent = 'reaction', turn, peer = {}, publicOnly = false, now = Date.now(), random = Math.random }) {
  const text = normalize(turn?.text)
  if (!turn?.id || !text) return { reason: 'context_unavailable' }
  if (refusesSticker.test(text)) return { reason: 'user_declined' }
  if (serious.test(text) && !asksSticker.test(text)) return { reason: 'serious_conversation' }
  const recent = peer.recent || []
  if (recent.some(r => r.turn === turn.id)) return { reason: 'already_sent_this_turn' }
  const invited = publicOnly && asksSticker.test(text)
  if (recent.some(r => now - r.at < (invited ? 15000 : 3 * 60000))) return { reason: 'cooldown' }
  if (recent.filter(r => now - r.at < (invited ? 2 : 20) * 60000).length >= (invited ? 8 : 3)) return { reason: 'rate_limit' }
  const query = normalize(keyword).replace(/[，,、;；]+/g, ' ')
  const terms = query.split(/\s+/).filter(t => t.length >= 2).slice(0, 6)
  if (!terms.length) return { reason: 'no_keyword' }
  const queryTags = tagsOf(query), contextTags = tagsOf(text)
  const repeated = new Set(recent.slice(-8).filter(r => now - r.at < 6 * 3600000).map(r => r.id))
  const candidates = []
  for (const item of index) {
    if (!item?.id || !item?.img || !item?.title) continue
    const id = String(item.id), title = normalize(item.title)
    if (peer.avoided?.[id] || repeated.has(id)) continue
    const tags = tagsOf(title)
    if (harsh.test(title) && (intent !== 'playful' || serious.test(text))) continue
    // Comfort requests must not receive crying, insulting or mocking images.
    if ((intent === 'comfort' || queryTags.has('comfort')) && (!tags.has('comfort') || harsh.test(title))) continue
    if (serious.test(text) && (harsh.test(title) || tags.has('laugh') || tags.has('playful'))) continue
    let score = 0
    let matched = true
    for (const term of terms) {
      if (title.includes(term)) { score += 10; continue }
      const aliases = tagsOf(term)
      if ([...aliases].some(tag => tags.has(tag))) score += 6
      else { matched = false; break }
    }
    if (!matched) continue
    score += [...contextTags].filter(t => tags.has(t)).length * 2
    // Prevent positive emotion queries from drifting into visibly opposite emotions.
    if ((queryTags.has('joy') || queryTags.has('laugh')) && tags.has('sad')) continue
    candidates.push({ item, score, weight: 1 + Math.min(3, peer.likes?.[id] || 0) + Math.min(1, (peer.uses?.[id] || 0) * .15) })
  }
  if (!candidates.length) return { reason: 'no_suitable_match' }
  candidates.sort((a, b) => b.score - a.score)
  const pool = candidates.filter(c => c.score >= candidates[0].score - 2).slice(0, 8)
  let draw = Math.max(0, Math.min(.999999, random())) * pool.reduce((n, c) => n + c.weight, 0)
  const pick = pool.find(c => (draw -= c.weight) < 0) || pool[0]
  return { item: pick.item, matchedCandidates: candidates.length }
}

function loadState(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (data.version !== 1 || !data.peers || typeof data.peers !== 'object') throw new Error('invalid sticker state')
    return data
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, peers: {} }
    throw error
  }
}
function saveState(file, data) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(data), { mode: 0o600 })
  renameSync(temp, file)
}

export function createStickerSender({ indexFile, publicIndexFile, stateFile, send, clock = Date.now, random = Math.random }) {
  const inFlight = new Set()
  const peerKey = (sid, uid) => createHash('sha256').update(sid + ':' + uid).digest('hex')
  const sender = async function sendSticker(args, exec, uid) {
    const sid = String(exec?.agent?.session?.header?.id || exec?.agent?.id || '')
    if (!sid) return { sent: false, reason: 'context_unavailable' }
    const key = peerKey(sid, uid)
    if (inFlight.has(key)) return { sent: false, reason: 'already_sending' }
    inFlight.add(key)
    try {
      const now = clock(), turn = conversationTurn(exec.agent.session)
      const state = loadState(stateFile)
      const peer = state.peers[key] ||= { recent: [], uses: {}, likes: {}, avoided: {} }
      feedback(peer, turn, now)
      // Persist feedback before selection, and verify writable state before external sending.
      saveState(stateFile, state)
      const index = JSON.parse(readFileSync(args.publicOnly ? publicIndexFile : indexFile, 'utf8'))
      if (!Array.isArray(index)) throw new Error('表情包索引格式不正确')
      const choice = chooseSticker(index, { ...args, turn, peer, now, random })
      if (!choice.item) return { sent: false, reason: choice.reason, hint: '这次用文字自然回应，不要反复调用或向对方解释选图过程' }
      const receipt = await send(choice.item, uid)
      // Another recipient may have completed a send during the await.
      const id = String(choice.item.id)
      let stateSaved = true
      try {
        const latest = loadState(stateFile)
        const current = latest.peers[key] ||= peer
        current.recent = [...(current.recent || []), { id, at: clock(), turn: turn.id }].slice(-16)
        current.uses ||= {}; current.uses[id] = (current.uses[id] || 0) + 1
        saveState(stateFile, latest)
      } catch { stateSaved = false }
      return { sent: true, to: uid, message_id: receipt?.message_id ?? null, title: choice.item.title, id, state_saved: stateSaved }
    } finally { inFlight.delete(key) }
  }
  sender.observe = (session, event, uid) => {
    const data = event?.data || event?.payload
    if (event?.type !== 'user/message' || !['user', 'qq'].includes(data?.source?.kind)) return
    if ((data.content || []).some(b => b.type === 'image')) return
    const sid = String(session?.header?.id || session?.id || '')
    if (!sid || !uid) return
    const state = loadState(stateFile), peer = state.peers[peerKey(sid, uid)]
    if (!peer) return
    const turn = conversationTurn({ snapshotEvents: () => [event] })
    const previous = peer.feedbackId
    feedback(peer, turn, clock())
    if (peer.feedbackId !== previous) saveState(stateFile, state)
  }
  return sender
}
