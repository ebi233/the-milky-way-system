import { writeFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const validSession = s => typeof s === 'string' && /^session-[a-zA-Z0-9-]+$/.test(s)
export function mergeGuestBindings(bindings, guests, owner) {
  const counts = new Map()
  for (const b of bindings) counts.set(b.会话, (counts.get(b.会话) || 0) + 1)
  const base = bindings.filter(b => validSession(b.会话) && counts.get(b.会话) === 1)
  const reserved = new Set(bindings.map(b => b.会话))
  for (const g of Object.values(guests)) if (g?.session) counts.set(g.session, (counts.get(g.session) || 0) + 1)
  return base.concat(Object.entries(guests).flatMap(([qq, g]) => {
    if (!/^\d+$/.test(qq) || qq === String(owner) || !validSession(g?.session)) return []
    if (reserved.has(g.session) || counts.get(g.session) !== 1 || base.some(b => b.类型 === '私聊' && String(b.号码) === qq)) return []
    return [{ 类型: '私聊', 号码: qq, 会话: g.session, 称呼: String(g.name || '客人').replace(/[\r\n]/g, '').slice(0,20), 门槛: false, 客人: true }]
  }))
}
export function allocateGuests(pool, guests, friends, conf, self) {
  if (!self || !conf.主人号码 || !Array.isArray(pool.sessions) || !Array.isArray(friends)) return { guests, added: 0 }
  const used = new Set(Object.values(guests).map(g => g?.session).filter(Boolean))
  const bound = new Set()
  for (const b of conf.绑定 || []) { used.add(b.会话); if (b.类型 === '私聊') bound.add(String(b.号码)) }
  used.add(conf.私聊会话); used.add(conf.目标会话)
  let added = 0
  const next = { ...guests }
  for (const friend of friends) {
    const qq = String(friend.user_id || '')
    if (!/^\d+$/.test(qq) || qq === String(conf.主人号码) || qq === String(self) || bound.has(qq) || Object.hasOwn(next, qq)) continue
    const session = pool.sessions.find(s => validSession(s) && !used.has(s))
    if (!session) break
    used.add(session)
    next[qq] = { name: '', session, nickname: String(friend.nickname || ''), first: Date.now() }
    added++
  }
  return { guests: next, added }
}
export function saveGuests(file, guests) {
  const tmp = `${file}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(guests, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}
