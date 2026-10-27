// Send history kept in the browser (Vercel can't remember between requests).
//  • events: every send for the last 7 days → rolling-24h caps, bounce rates
//  • contacted: every address ever cold-emailed, kept forever, so the same
//    business never gets a first email twice

const EVENTS_KEY = 'rmv2_send_events'
const CONTACTED_KEY = 'rmv2_contacted_emails'
const DAY = 86400000
const KEEP = 7 * DAY

const lower = (s) => String(s || '').trim().toLowerCase()

// The Live tab and caps read this many times a second, so keep a parsed copy
// for up to a second instead of re-parsing localStorage on every call.
let evCache = null
let evCacheAt = 0
function readEvents() {
  if (evCache && Date.now() - evCacheAt < 1000) return evCache
  try {
    const raw = JSON.parse(localStorage.getItem(EVENTS_KEY) || '[]')
    evCache = Array.isArray(raw) ? raw.filter(e => e && typeof e.at === 'number' && e.at > Date.now() - KEEP) : []
  } catch { evCache = [] }
  evCacheAt = Date.now()
  return evCache
}
function writeEvents(ev) {
  evCache = ev; evCacheAt = Date.now()
  try { localStorage.setItem(EVENTS_KEY, JSON.stringify(ev)) } catch {}
}
export function exportEvents() { return readEvents() }
export function importEvents(list) {
  if (!Array.isArray(list)) return
  const have = new Set(readEvents().map(e => `${e.account}|${e.kind}|${e.at}`))
  writeEvents([...readEvents(), ...list.filter(e => e && typeof e.at === 'number' && e.at > Date.now() - KEEP && !have.has(`${e.account}|${e.kind}|${e.at}`))])
}

// kind: 'cold' | 'warmup' | 'reply' | 'bounce'
export function recordEvent(account, kind = 'cold', extra = {}) {
  evCache = null
  const ev = [...readEvents()]
  ev.push({ account: lower(account), kind, at: Date.now(), ...extra })
  writeEvents(ev)
}

export function eventsSince(ms, filter = {}) {
  const cutoff = Date.now() - ms
  return readEvents().filter(e => e.at > cutoff &&
    (!filter.account || e.account === lower(filter.account)) &&
    (!filter.kind || (e.kind || 'cold') === filter.kind))
}

// Old events have no kind; they were all cold sends.
export function count24h(account, kind = 'cold') {
  return eventsSince(DAY, { account, kind }).length
}

export function stats(account) {
  const week = eventsSince(KEEP, { account })
  const by = (k) => week.filter(e => (e.kind || 'cold') === k).length
  const day = eventsSince(DAY, { account })
  const byDay = (k) => day.filter(e => (e.kind || 'cold') === k).length
  const cold7 = by('cold'), bounce7 = by('bounce')
  return {
    cold24: byDay('cold'), warm24: byDay('warmup'), replies24: byDay('reply'),
    cold7, bounce7, replies7: by('reply'),
    bounceRate: cold7 ? bounce7 / cold7 : 0,
  }
}

// When does the oldest cold send in the window roll off?
export function nextFreeAt(account) {
  const ev = eventsSince(DAY, { account, kind: 'cold' })
  if (!ev.length) return null
  return new Date(Math.min(...ev.map(e => e.at)) + DAY)
}

// Sends per day over the last 7 days for one or all inboxes (for the dashboard)
export function dailySeries(days = 7) {
  const ev = readEvents()
  const out = []
  for (let i = days - 1; i >= 0; i--) {
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - i)
    const end = start.getTime() + DAY
    const inDay = ev.filter(e => e.at >= start.getTime() && e.at < end)
    out.push({
      label: start.toLocaleDateString('en-AU', { weekday: 'short' }),
      cold: inDay.filter(e => (e.kind || 'cold') === 'cold').length,
      warmup: inDay.filter(e => e.kind === 'warmup').length,
      reply: inDay.filter(e => e.kind === 'reply').length,
    })
  }
  return out
}

// ── Permanent contacted history ───────────────────────────────
function readContacted() {
  try {
    const raw = JSON.parse(localStorage.getItem(CONTACTED_KEY) || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}
export function hasBeenContacted(email) { return !!(email && readContacted()[lower(email)]) }
export function markContacted(email) {
  if (!email) return
  const all = readContacted()
  const k = lower(email)
  if (!all[k]) { all[k] = new Date().toISOString(); try { localStorage.setItem(CONTACTED_KEY, JSON.stringify(all)) } catch {} }
}
export function contactedCount() { return Object.keys(readContacted()).length }
export function exportContacted() { return readContacted() }
export function importContacted(obj) {
  const merged = { ...(obj || {}), ...readContacted() }
  try { localStorage.setItem(CONTACTED_KEY, JSON.stringify(merged)) } catch {}
  return Object.keys(merged).length
}
export function clearContacted() { try { localStorage.removeItem(CONTACTED_KEY) } catch {} }
