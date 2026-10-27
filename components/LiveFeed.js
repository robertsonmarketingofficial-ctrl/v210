// Live view of the send engine: what it's doing this second, today's numbers,
// each inbox's progress, and a running feed of every send, reply and problem.

import { useEffect, useMemo, useState } from 'react'
import { useStore, KEYS, set } from './store'
import { accountsView, activeCapacity, useEngineStatus, queueInfo, SESSION_START } from './engine'
import { eventsSince } from './tracker'
import { fmtIn, downloadFile, toCSV, Empty } from './ui'

const HOUR = 3600000
const DAY = 86400000

const TYPES = {
  sent: { label: 'SENT', cls: 'ok' },
  reply: { label: 'REPLY', cls: 'bolt' },
  bounce: { label: 'BOUNCE', cls: 'bad' },
  failed: { label: 'FAILED', cls: 'bad' },
  skipped: { label: 'SKIPPED', cls: 'warn' },
  invalid: { label: 'WOULD BOUNCE', cls: 'warn' },
  paused: { label: 'PAUSED', cls: 'warn' },
}

const FILTERS = [
  ['all', 'All'],
  ['sent', 'Sent'],
  ['reply', 'Replies'],
  ['problems', 'Problems'],
]

export function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`
  return new Date(at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
}
const time = (at) => new Date(at).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '–')
const short = (email) => String(email || '').split('@')[0]

function useTick(ms = 1000) {
  const [, f] = useState(0)
  useEffect(() => { const t = setInterval(() => f(x => x + 1), ms); return () => clearInterval(t) }, [ms])
}

function headline(e) {
  switch (e.type) {
    case 'sent': return <>Sent to <b className="feed-email">{e.email}</b></>
    case 'reply': return <>{e.negative ? 'Reply (looks like a no) from ' : 'Reply from '}<b className="feed-email">{e.email}</b></>
    case 'bounce': return <>Bounced: <b className="feed-email">{e.email}</b></>
    case 'failed': return <>Failed to send to <b className="feed-email">{e.email}</b></>
    case 'skipped': return <>Skipped <b className="feed-email">{e.email}</b></>
    case 'invalid': return <>Didn’t send, would bounce: <b className="feed-email">{e.email}</b></>
    case 'paused': return <>Inbox paused: <b className="feed-email">{e.from}</b></>
    default: return e.type
  }
}

export function FeedRow({ e, compact }) {
  const t = TYPES[e.type] || { label: e.type.toUpperCase(), cls: '' }
  const where = [e.category, [e.suburb, e.state].filter(Boolean).join(' ')].filter(Boolean).join(' · ')
  const fresh = Date.now() - e.at < 4000
  return (
    <div className={`feed-row${fresh ? ' fresh' : ''}`}>
      <div className="feed-time" title={new Date(e.at).toLocaleString('en-AU')}>{time(e.at)}<div className="muted">{ago(e.at)}</div></div>
      <span className={`tag ${t.cls}`} style={{ minWidth: 66, justifyContent: 'center' }}>{t.label}</span>
      <div className="feed-main">
        <div className="feed-head">{headline(e)}{e.name && <span className="dim"> · {e.name}</span>}</div>
        {!compact && (
          <div className="feed-sub">
            {where && <span>{where}</span>}
            {e.step && <span>Email {e.step} of {e.steps}{e.followUp ? ' (follow-up)' : ''}</span>}
            {e.type === 'reply' && e.afterStep ? <span>after email {e.afterStep}</span> : null}
            {e.from && e.type !== 'paused' && <span>{e.type === 'reply' ? 'to' : 'from'} {e.from}</span>}
            {e.campaign && <span>{e.campaign}</span>}
            {e.subject && <span className="feed-subj">“{e.subject}”</span>}
            {typeof e.ms === 'number' && e.type === 'sent' && <span>{(e.ms / 1000).toFixed(1)}s</span>}
            {e.attempt && <span>attempt {e.attempt}{e.willRetry ? `, retrying in ${e.retryMins || 15} min` : ', giving up'}</span>}
          </div>
        )}
        {e.snippet && <div className="feed-snip">{e.snippet}</div>}
        {e.error && <div className="feed-err">{e.error}</div>}
      </div>
    </div>
  )
}

const hl = (h) => { h = Number(h) % 24; return h === 0 ? 'midnight' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm` }

function NowBar() {
  const st = useEngineStatus()
  const [s] = useStore(KEYS.settings)
  let tone = '', text = ''
  if (!s.engineOn) { tone = ''; text = 'Sending is paused. Press Start sending (top right).' }
  else if (!st.holder) { tone = 'warn'; text = 'The engine is running in another CRM tab. Watch that tab, or close it.' }
  else if (st.current) { tone = 'live'; text = <>Sending email {st.current.step} of {st.current.steps} to <b>{st.current.to}</b> from {st.current.from}…</> }
  else if (!st.windowOpen) { tone = 'idle'; text = s.weekdaysOnly && [0, 6].includes(new Date().getDay()) ? 'It’s the weekend and weekdays-only is on (Settings). Picks back up Monday.' : `Outside sending hours. Picks back up at ${hl(s.windowStart)}.` }
  else if (st.nextColdAt && st.nextColdAt > Date.now()) { tone = 'live'; text = <>Next email in <b>{fmtIn(st.nextColdAt)}</b></> }
  else { tone = 'idle'; text = st.message }
  return (
    <div className="panel pad row" style={{ gap: 12 }}>
      <span className={`dot ${tone === 'live' ? 'live' : tone === 'idle' || tone === 'warn' ? 'idle' : ''}`} />
      <div className="grow">{text}</div>
      {st.lastSync ? <span className="small muted">Replies checked {ago(st.lastSync)}</span> : null}
    </div>
  )
}

function Num({ v, l, sub, tone }) {
  return (
    <div className="panel stat">
      <div className={`stat-v ${tone || ''}`}>{v}</div>
      <div className="stat-l">{l}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

export default function LiveFeed() {
  const [items] = useStore(KEYS.feed)
  useStore(KEYS.accounts)
  useStore(KEYS.pipeline)
  useTick(1000)
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(100)

  const view = accountsView()
  const cap = activeCapacity(view)
  const queue = queueInfo()

  const nums = useMemo(() => {
    const day = (items || []).filter(e => e.at > Date.now() - DAY)
    const sent24 = eventsSince(DAY, { kind: 'cold' }).length
    const sentHour = eventsSince(HOUR, { kind: 'cold' }).length
    const replies24 = eventsSince(DAY, { kind: 'reply' }).length
    const bounces24 = eventsSince(DAY, { kind: 'bounce' }).length
    const sent7 = eventsSince(7 * DAY, { kind: 'cold' }).length
    const replies7 = eventsSince(7 * DAY, { kind: 'reply' }).length
    const failed24 = day.filter(e => e.type === 'failed').length
    const saved24 = day.filter(e => e.type === 'invalid').length
    const session = (items || []).filter(e => e.at >= SESSION_START && e.type === 'sent').length
    const lastSent = [...(items || [])].reverse().find(e => e.type === 'sent')
    const sentDay = day.filter(e => e.type === 'sent')
    const avgMs = sentDay.length ? sentDay.reduce((n, e) => n + (e.ms || 0), 0) / sentDay.length : 0
    const firstStep = sentDay.filter(e => !e.followUp).length
    return { sent24, sentHour, replies24, bounces24, sent7, replies7, failed24, saved24, session, lastSent, avgMs, firstStep, followUps: sentDay.length - firstStep }
  }, [items, Math.floor(Date.now() / 5000)]) // eslint-disable-line

  const left = Math.max(0, cap - nums.sent24)
  const etaMs = nums.sentHour && left ? (left / nums.sentHour) * HOUR : null

  const perInbox = useMemo(() => {
    const last = {}
    for (const e of items || []) if (e.type === 'sent' && e.from) last[e.from.toLowerCase()] = e.at
    return last
  }, [items])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return [...(items || [])].reverse().filter(e => {
      if (filter === 'sent' && e.type !== 'sent') return false
      if (filter === 'reply' && e.type !== 'reply') return false
      if (filter === 'problems' && !['bounce', 'failed', 'skipped', 'paused', 'invalid'].includes(e.type)) return false
      if (!needle) return true
      return [e.email, e.name, e.from, e.campaign, e.suburb, e.category, e.subject].some(x => String(x || '').toLowerCase().includes(needle))
    })
  }, [items, filter, q])

  const exportCSV = () => downloadFile(`send-feed-${new Date().toISOString().slice(0, 10)}.csv`, toCSV([...(items || [])].reverse(), [
    { label: 'Time', get: e => new Date(e.at).toLocaleString('en-AU') },
    { label: 'Type', key: 'type' }, { label: 'Email', key: 'email' }, { label: 'Business', key: 'name' },
    { label: 'Category', key: 'category' }, { label: 'Suburb', key: 'suburb' }, { label: 'State', key: 'state' },
    { label: 'Inbox', key: 'from' }, { label: 'Campaign', key: 'campaign' }, { label: 'Step', get: e => e.step ? `${e.step}/${e.steps}` : '' },
    { label: 'Subject', key: 'subject' }, { label: 'Error', key: 'error' }, { label: 'Reply snippet', key: 'snippet' },
  ]), 'text/csv')

  return (
    <div className="stack">
      <NowBar />

      <div className="grid3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        <Num v={nums.session} l="Sent this session" sub={`since you opened the CRM ${ago(SESSION_START)}`} tone="bolt" />
        <Num v={<>{nums.sent24}<span className="muted" style={{ fontSize: 15 }}> / {cap}</span></>} l="Sent, last 24h" sub={`${left} left · ${nums.firstStep} first emails, ${nums.followUps} follow-ups`} />
        <Num v={nums.sentHour} l="Sent, last hour" sub={!cap ? 'no Active inboxes' : etaMs ? `at this pace, today's limit is hit in ${fmtIn(Date.now() + etaMs)}` : left ? 'no sends this hour yet' : 'daily limit reached'} />
        <Num v={nums.lastSent ? ago(nums.lastSent.at) : '–'} l="Last email sent" sub={nums.lastSent ? `to ${nums.lastSent.email}` : 'nothing yet'} />
        <Num v={nums.replies24} l="Replies, last 24h" sub={`${pct(nums.replies7, nums.sent7)} reply rate over 7 days`} tone={nums.replies24 ? 'ok' : ''} />
        <Num v={nums.bounces24} l="Bounces, last 24h" sub={`${pct(nums.bounces24, nums.sent24)} of today's sends${nums.sent24 && nums.bounces24 / nums.sent24 > 0.03 ? ' · too high, check your list' : ''}`} tone={nums.sent24 && nums.bounces24 / nums.sent24 > 0.03 ? 'bad' : ''} />
        <Num v={nums.failed24} l="Failed sends, last 24h" sub={nums.failed24 ? 'see Problems below' : 'all clean'} tone={nums.failed24 ? 'bad' : ''} />
        <Num v={nums.saved24} l="Bounces prevented, 24h" sub="dead addresses skipped before sending" tone={nums.saved24 ? 'ok' : ''} />
        <Num v={queue.dueNow} l="Due to send now" sub={`${queue.waiting} leads in a sequence · ${queue.followUpsDue} follow-ups due`} />
      </div>

      <div className="panel">
        <div className="panel-head"><div className="panel-title">Inboxes right now</div><span className="small muted">avg send time {nums.avgMs ? `${(nums.avgMs / 1000).toFixed(1)}s` : '–'}</span></div>
        <div className="pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 14 }}>
          {!view.length && <div className="muted small">No inboxes connected.</div>}
          {view.map(a => {
            const last = perInbox[a.user.toLowerCase()]
            return (
              <div key={a.user}>
                <div className="row small" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                  <span className="dim" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.user}</span>
                  <span className={a.status === 'active' ? 'ok num' : a.status === 'paused' ? 'bad' : 'warmc'}>{a.status === 'active' ? `${a.cold24}/${a.cap}` : a.status}</span>
                </div>
                <div className="bar" style={{ marginTop: 5 }}><span className="c" style={{ width: `${a.status === 'active' && a.cap ? Math.min(100, (a.cold24 / a.cap) * 100) : 0}%` }} /></div>
                <div className="small muted" style={{ marginTop: 4 }}>
                  {last ? `last sent ${ago(last)}` : 'no sends yet'} · {a.replies7} replies, {a.bounce7} bounces (7d)
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div className="row">
            <div className="panel-title">Live feed</div>
            <div className="chips">{FILTERS.map(([k, l]) => <button key={k} className={`chip${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>{l}</button>)}</div>
          </div>
          <div className="row">
            <input className="input sm" placeholder="Search email, business, inbox…" value={q} onChange={e => setQ(e.target.value)} style={{ width: 220 }} />
            <button className="btn ghost sm" disabled={!items?.length} onClick={exportCSV}>Export CSV</button>
            <button className="btn ghost sm" disabled={!items?.length} onClick={() => { if (confirm('Clear the live feed? Your send counts and leads are not affected.')) set(KEYS.feed, []) }}>Clear</button>
          </div>
        </div>
        <div className="feed">
          {!rows.length && <Empty title={items?.length ? 'Nothing matches' : 'Nothing sent yet'} sub={items?.length ? 'Try another filter.' : 'Every email the engine sends shows up here the moment it goes out.'} />}
          {rows.slice(0, limit).map(e => <FeedRow key={e.id || e.at} e={e} />)}
          {rows.length > limit && <div className="pad"><button className="btn ghost sm" onClick={() => setLimit(x => x + 100)}>Show more ({rows.length - limit} older)</button></div>}
        </div>
      </div>
    </div>
  )
}

// Small version for the Dashboard
export function MiniFeed({ onOpen }) {
  const [items] = useStore(KEYS.feed)
  useTick(5000)
  const last = [...(items || [])].reverse().slice(0, 6)
  return (
    <div className="panel">
      <div className="panel-head"><div className="panel-title">Live feed</div><button className="btn ghost sm" onClick={onOpen}>Open</button></div>
      <div className="feed">
        {!last.length ? <Empty title="Nothing sent yet" sub="Sends, replies and bounces show up here live." /> : last.map(e => <FeedRow key={e.id || e.at} e={e} compact />)}
      </div>
    </div>
  )
}
