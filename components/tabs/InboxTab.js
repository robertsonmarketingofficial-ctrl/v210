import { useEffect, useMemo, useState } from 'react'
import { useStore, KEYS, set, STAGES, patchLead, settings as getSettings } from '../store'
import { useEngineStatus, syncNow, log } from '../engine'
import { recordEvent } from '../tracker'
import { apiJSON } from '../api'
import { Empty, Spinner, toast, fmtWhen } from '../ui'

const FILTERS = [
  { id: 'todo', label: 'Needs reply', test: m => m.kind === 'reply' && !m.handled },
  { id: 'replies', label: 'All replies', test: m => m.kind === 'reply' },
  { id: 'auto', label: 'Auto-replies', test: m => m.kind === 'auto' },
  { id: 'bounce', label: 'Bounces', test: m => m.kind === 'bounce' },
  { id: 'other', label: 'Other mail', test: m => m.kind === 'other' },
]

const QUICK = [
  { label: 'Book a call', text: 'Awesome, thanks for getting back to me. What does your week look like for a quick 10 minute call? I’m flexible, just let me know a day and time that suits.' },
  { label: 'Send details', text: 'Good question. In short, I set up and run Facebook and Instagram ads that bring in job enquiries, and you only keep going if it’s working. Easiest way to explain is a quick 10 minute call. When suits?' },
  { label: 'No worries', text: 'No worries at all, thanks for letting me know. I won’t follow up again. All the best with the business.' },
]

function Reply({ msg, lead, onSent }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const s = getSettings()
  const send = async () => {
    if (!text.trim()) return
    setSending(true)
    const subject = /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`
    const body = `${text.trim()}\n\n${s.fromName.split(' ')[0]}`
    const r = await apiJSON('/api/send', {
      method: 'POST',
      body: { from: msg.account, to: msg.fromEmail, subject, text: body, inReplyTo: msg.messageId, references: [...(msg.references || []), msg.messageId].filter(Boolean), fromName: s.fromName },
    })
    setSending(false)
    if (!r.success) { toast(`Didn’t send: ${r.error}`); return }
    recordEvent(msg.account, 'manual')
    if (lead) patchLead(lead.id, l => ({ manualSends: [...(l.manualSends || []), { at: Date.now(), account: msg.account, subject, text: body, messageId: r.messageId }] }))
    set(KEYS.inbox, i => ({ ...i, messages: i.messages.map(m => m.id === msg.id ? { ...m, handled: true } : m) }))
    log(`Replied to ${lead?.name || msg.fromEmail}`, 'sent')
    toast('Reply sent')
    setText('')
    onSent?.()
  }
  return (
    <div className="panel pad" style={{ background: 'rgba(0,0,0,.4)' }}>
      <div className="chips" style={{ marginBottom: 10 }}>{QUICK.map(q => <button key={q.label} className="chip" onClick={() => setText(q.text)}>{q.label}</button>)}</div>
      <textarea className="textarea" rows={5} value={text} onChange={e => setText(e.target.value)} placeholder={`Reply from ${msg.account}…`} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send() }} />
      <div className="row" style={{ marginTop: 10 }}>
        <span className="small muted grow">Sends from {msg.account}, in the same thread. Your first name is added as the sign-off. Ctrl+Enter to send.</span>
        <button className="btn primary" disabled={sending || !text.trim()} onClick={send}>{sending ? <Spinner size={12} /> : 'Send reply'}</button>
      </div>
    </div>
  )
}

export default function InboxTab() {
  const [inbox] = useStore(KEYS.inbox)
  const [pipeline] = useStore(KEYS.pipeline)
  const st = useEngineStatus()
  const [filter, setFilter] = useState('todo')
  const [acct, setAcct] = useState('All')
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState(null)

  const messages = inbox.messages || []
  const leadsById = useMemo(() => new Map(pipeline.map(l => [l.id, l])), [pipeline])
  const f = FILTERS.find(x => x.id === filter)
  const list = messages.filter(m => f.test(m) && (acct === 'All' || m.account === acct) &&
    (!q || [m.fromEmail, m.fromName, m.subject, m.text, leadsById.get(m.leadId)?.name].some(v => String(v || '').toLowerCase().includes(q.toLowerCase()))))
  const open = messages.find(m => m.id === openId) || null
  const lead = open?.leadId ? leadsById.get(open.leadId) : null

  useEffect(() => {
    if (!open || open.seen) return
    set(KEYS.inbox, i => ({ ...i, messages: i.messages.map(m => m.id === open.id ? { ...m, seen: true } : m) }))
    apiJSON('/api/inbox', { method: 'POST', body: { account: open.account, action: 'seen', uid: open.uid } })
  }, [openId]) // eslint-disable-line

  const thread = useMemo(() => {
    if (!open) return []
    if (!lead) return [{ me: false, at: new Date(open.date).getTime(), subject: open.subject, text: open.text, who: open.fromName || open.fromEmail }]
    return [
      ...(lead.seq?.sends || []).map(s => ({ me: true, at: s.at, subject: s.subject, text: s.text, who: `You (${s.account})` })),
      ...(lead.manualSends || []).map(s => ({ me: true, at: s.at, subject: s.subject, text: s.text, who: `You (${s.account})` })),
      ...messages.filter(m => m.leadId === lead.id && m.kind !== 'bounce').map(m => ({ me: false, at: new Date(m.date).getTime(), subject: m.subject, text: m.text, who: m.fromName || m.fromEmail })),
    ].sort((a, b) => a.at - b.at)
  }, [open, lead, messages])

  const markHandled = (v) => set(KEYS.inbox, i => ({ ...i, messages: i.messages.map(m => m.id === open.id ? { ...m, handled: v } : m) }))
  const errors = Object.entries(inbox.errors || {})
  const accounts = ['All', ...st.serverAccounts]

  return (
    <div className="stack">
      <div className="row">
        <div className="chips">{FILTERS.map(x => <button key={x.id} className={`chip${filter === x.id ? ' on' : ''}`} onClick={() => setFilter(x.id)}>{x.label} {messages.filter(x.test).length}</button>)}</div>
        <div className="grow" />
        <select className="select sm" value={acct} onChange={e => setAcct(e.target.value)} aria-label="Inbox">{accounts.map(a => <option key={a} value={a}>{a === 'All' ? 'All inboxes' : a}</option>)}</select>
        <input className="input sm" style={{ width: 200 }} placeholder="Search" value={q} onChange={e => setQ(e.target.value)} />
        <span className="small muted">{st.syncing ? 'Checking…' : inbox.lastSync ? `Checked ${fmtWhen(inbox.lastSync)}` : 'Not checked yet'}</span>
        <button className="btn sm" disabled={st.syncing} onClick={syncNow}>{st.syncing ? <Spinner size={12} /> : 'Check now'}</button>
      </div>
      {errors.length > 0 && <div className="panel pad small">{errors.map(([a, e]) => <div key={a}><span className="bad">{a}:</span> <span className="dim">{e}</span></div>)}</div>}

      <div className="panel inbox">
        <div className="inbox-list">
          {!list.length && <Empty title={filter === 'todo' ? 'All caught up' : 'Nothing here'} sub={filter === 'todo' ? 'New replies show up here. Each inbox is checked every few minutes.' : ''} />}
          {list.map(m => {
            const l = m.leadId ? leadsById.get(m.leadId) : null
            return (
              <div key={m.id} className={`msg-item${openId === m.id ? ' on' : ''}${!m.seen ? ' unread' : ''}`} onClick={() => setOpenId(m.id)}>
                <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  <div className="msg-from grow">{l?.name || m.fromName || m.fromEmail}</div>
                  {m.tag && <span className="tag bad">{m.tag}</span>}
                  <span className="small muted">{fmtWhen(m.date)}</span>
                </div>
                <div className="msg-snip">{m.kind === 'bounce' ? `Bounced: ${m.bouncedTo || 'unknown address'}` : (m.text || m.subject).slice(0, 120)}</div>
              </div>
            )
          })}
        </div>
        <div className="thread">
          {!open ? <Empty title="Pick a message" sub="Your sequence emails and their replies show together as one conversation." /> : (
            <div className="stack">
              <div className="row">
                <div className="grow">
                  <div className="panel-title">{lead?.name || open.fromName || open.fromEmail}</div>
                  <div className="small muted">{open.fromEmail} → {open.account}</div>
                </div>
                {lead && (
                  <select className="select sm" value={lead.stage} onChange={e => patchLead(lead.id, { stage: e.target.value })} aria-label="Stage">{STAGES.map(s => <option key={s}>{s}</option>)}</select>
                )}
                {open.kind === 'reply' && <button className="btn sm" onClick={() => markHandled(!open.handled)}>{open.handled ? 'Move back to Needs reply' : 'Done, no reply needed'}</button>}
              </div>
              {lead && (
                <div className="chips">
                  {['Interested', 'Meeting booked', 'Won', 'Not interested'].map(sg => <button key={sg} className={`chip${lead.stage === sg ? ' on' : ''}`} onClick={() => { patchLead(lead.id, { stage: sg }); toast(`${lead.name} → ${sg}`) }}>{sg}</button>)}
                </div>
              )}
              {open.kind === 'bounce' && <div className="bubble them"><div className="bubble-meta">Delivery failure for {open.bouncedTo || 'an address'}. That lead’s sequence has been stopped.</div>{open.text.slice(0, 1500)}</div>}
              {open.kind !== 'bounce' && thread.map((t, i) => (
                <div key={i} className={`bubble ${t.me ? 'me' : 'them'}`}>
                  <div className="bubble-meta">{t.who} · {new Date(t.at).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} · {t.subject}</div>
                  {t.text}
                </div>
              ))}
              {open.kind !== 'bounce' && <Reply msg={open} lead={lead} />}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
