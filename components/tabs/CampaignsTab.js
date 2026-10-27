import { useMemo, useState } from 'react'
import { useStore, KEYS, set, get, uid, updateLeads, settings as getSettings } from '../store'
import { enrollLeads, accountsView, useEngineStatus, setAccountMeta, setInboxCap, activeCapacity, sendNow, MAX_INBOX_CAP } from '../engine'
import { render, TOKENS } from '../templating'
import { apiJSON } from '../api'
import { Modal, Empty, Field, Spinner, toast, fmtIn, CheckTag } from '../ui'
import { checkEmails } from '../verifyClient'

export const DEFAULT_STEPS = [
  {
    subject: '{quick question|{{suburb}} jobs|question for {{name}}}',
    body: `{Hey|Hi|G'day} {{name}} team,

{Quick one|Random question}: are you taking on more {{category}} work around {{suburb}} at the moment?

I run Facebook and Instagram ads for tradies that bring in booked jobs, not just likes. {Happy to|Keen to} show you what it would look like for {{name}}, no cost to have a look.

Worth a quick chat this week?

{{sender}}
Robertson Marketing

P.S. Not the right person, or not interested? Just reply "no" and I won't follow up.`,
    delayDays: 0,
  },
  {
    subject: '',
    body: `{Hey|Hi} again,

Just bumping this up in case it got buried. {Would a few extra jobs a week|Would more enquiries} be useful for {{name}} right now?

{{sender}}`,
    delayDays: 3,
  },
  {
    subject: '',
    body: `{Hey|Hi} {{name}} team,

I'll leave it here so I'm not clogging up your inbox. If getting more {{category}} jobs through Facebook ever becomes a priority, reply to this and I'll send through a few ideas.

{Cheers|Thanks},
{{sender}}`,
    delayDays: 4,
  },
]

const SAMPLE = { name: 'Smith Bros Plumbing Pty Ltd', category: 'Plumber', address: '12 Main North Rd, Salisbury SA 5108, Australia', rating: 4.1, reviewCount: 23, email: 'info@smithbros.com.au' }
const POSITIVE = ['Interested', 'Meeting booked', 'Won']

function campaignStats(camp, leads) {
  const inC = leads.filter(l => l.seq?.campaignId === camp.id)
  const sent = inC.reduce((n, l) => n + (l.seq.sends || []).length, 0)
  const contacted = inC.filter(l => (l.seq.sends || []).length).length
  const replied = inC.filter(l => l.seq.status === 'replied' || l.lastReplyAt).length
  return {
    enrolled: inC.length,
    queued: inC.filter(l => l.seq.status === 'queued').length,
    active: inC.filter(l => l.seq.status === 'active').length,
    done: inC.filter(l => l.seq.status === 'done').length,
    bounced: inC.filter(l => l.seq.status === 'bounced' || l.bounced).length,
    sent, contacted, replied,
    positive: inC.filter(l => POSITIVE.includes(l.stage)).length,
    meetings: inC.filter(l => ['Meeting booked', 'Won'].includes(l.stage)).length,
    leads: inC,
  }
}

const pct = (a, b) => b ? `${((a / b) * 100).toFixed(1)}%` : '–'

function StepEditor({ step, index, onChange, onRemove, onFocus }) {
  const isFirst = index === 0
  return (
    <div className="panel pad" style={{ background: 'rgba(0,0,0,.35)' }}>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="tag bolt">Email {index + 1}</span>
        {!isFirst && (
          <span className="small dim row" style={{ gap: 6 }}>
            sent
            <input className="input sm num" type="number" min={1} max={30} value={step.delayDays} style={{ width: 60 }}
              onChange={e => onChange({ ...step, delayDays: Math.max(1, Number(e.target.value) || 1) })} />
            days after email {index}, if no reply
          </span>
        )}
        {!isFirst && <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={onRemove}>Remove</button>}
      </div>
      <Field label={isFirst ? 'Subject' : 'Subject (leave blank to reply in the same thread)'}>
        <input className="input" value={step.subject} onFocus={() => onFocus('subject')} onChange={e => onChange({ ...step, subject: e.target.value })} placeholder={isFirst ? 'quick question' : 'Re: (same thread)'} />
      </Field>
      <div style={{ height: 10 }} />
      <Field label="Body">
        <textarea className="textarea" rows={isFirst ? 11 : 6} value={step.body} onFocus={() => onFocus('body')} onChange={e => onChange({ ...step, body: e.target.value })} />
      </Field>
    </div>
  )
}

function Editor({ camp, onClose, sampleLead }) {
  const [draft, setDraft] = useState(() => JSON.parse(JSON.stringify(camp)))
  const [focus, setFocus] = useState({ step: 0, field: 'body' })
  const [previewStep, setPreviewStep] = useState(0)
  const [seed, setSeed] = useState(0)
  const [testTo, setTestTo] = useState('')
  const [testing, setTesting] = useState(false)
  const s = getSettings()
  const lead = sampleLead || SAMPLE

  const setStep = (i, st) => setDraft(d => ({ ...d, steps: d.steps.map((x, j) => j === i ? st : x) }))
  const insert = (tok) => {
    const st = draft.steps[focus.step]
    setStep(focus.step, { ...st, [focus.field]: `${st[focus.field]}{{${tok}}}` })
  }
  const save = () => {
    if (!draft.name.trim()) { toast('Give the campaign a name'); return }
    if (!draft.steps[0].subject.trim() || !draft.steps[0].body.trim()) { toast('Email 1 needs a subject and a body'); return }
    const saved = { ...draft, createdAt: draft.createdAt || new Date().toISOString() }
    set(KEYS.campaigns, list => list.some(c => c.id === saved.id) ? list.map(c => c.id === saved.id ? saved : c) : [...list, saved])
    toast('Campaign saved')
    onClose()
  }

  const preview = useMemo(() => {
    const st = draft.steps[previewStep] || draft.steps[0]
    const subj = previewStep > 0 && !st.subject.trim() ? `Re: ${render(draft.steps[0].subject, lead, s)}` : render(st.subject, lead, s)
    return { subject: subj, body: render(st.body, lead, s) }
    // seed re-rolls the spintax
  }, [draft, previewStep, seed]) // eslint-disable-line

  const warnings = []
  const body0 = draft.steps[0]?.body || ''
  if (/https?:\/\//i.test(body0)) warnings.push('Links in a first cold email hurt deliverability. Save them for after they reply.')
  if (body0.split(/\s+/).length > 140) warnings.push('Email 1 is long. Under ~100 words gets more replies.')
  if (!/\{[^{}]*\|[^{}]*\}/.test(body0)) warnings.push('No {spintax|variations} in email 1. Mixing a few words up stops 200 identical emails a day.')

  const sendTest = async () => {
    const acc = accountsView().find(a => a.loginOk !== false)
    if (!acc) { toast('No inbox available to send from'); return }
    if (!testTo.trim()) { toast('Enter your own email to send a test to'); return }
    setTesting(true)
    const r = await apiJSON('/api/send', { method: 'POST', body: { from: acc.user, to: testTo.trim(), subject: `[TEST] ${preview.subject}`, text: preview.body, fromName: s.fromName } })
    setTesting(false)
    toast(r.success ? `Test sent from ${acc.user}` : `Test failed: ${r.error}`)
  }

  return (
    <Modal title={camp.createdAt ? `Edit: ${camp.name}` : 'New campaign'} onClose={onClose} width={1100}>
      <div className="grid2" style={{ alignItems: 'start' }}>
        <div className="stack">
          <Field label="Campaign name"><input className="input" value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} placeholder="SA plumbers, Nov" /></Field>
          <div>
            <span className="label">Insert into email {focus.step + 1} {focus.field}</span>
            <div className="chips">{TOKENS.map(t => <button key={t} className="chip" onClick={() => insert(t)}>{`{{${t}}}`}</button>)}</div>
            <div className="small muted" style={{ marginTop: 6 }}>Write {'{Hey|Hi|G’day}'} and each email picks one at random.</div>
          </div>
          {draft.steps.map((st, i) => (
            <StepEditor key={i} step={st} index={i} onChange={x => setStep(i, x)}
              onRemove={() => setDraft(d => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }))}
              onFocus={(field) => { setFocus({ step: i, field }); setPreviewStep(i) }} />
          ))}
          {draft.steps.length < 5 && <button className="btn" onClick={() => setDraft(d => ({ ...d, steps: [...d.steps, { subject: '', body: '{Hey|Hi} again,\n\n\n\n{{sender}}', delayDays: 4 }] }))}>Add follow-up</button>}
        </div>
        <div className="stack" style={{ position: 'sticky', top: 0 }}>
          <div className="row">
            <div className="seg">{draft.steps.map((_, i) => <button key={i} className={previewStep === i ? 'on' : ''} onClick={() => setPreviewStep(i)}>Email {i + 1}</button>)}</div>
            <button className="btn ghost sm" onClick={() => setSeed(x => x + 1)}>Shuffle variations</button>
          </div>
          <div className="small muted">Preview for {sampleLead ? sampleLead.name : 'a sample lead'}</div>
          <div className="preview"><div className="dim" style={{ marginBottom: 10 }}>Subject: <span style={{ color: 'var(--text)' }}>{preview.subject}</span></div>{preview.body}</div>
          {warnings.map(w => <div key={w} className="small warn">{w}</div>)}
          <div className="row">
            <input className="input grow" style={{ width: 'auto' }} placeholder="Send a test to your own email" value={testTo} onChange={e => setTestTo(e.target.value)} />
            <button className="btn" disabled={testing} onClick={sendTest}>{testing ? <Spinner size={12} /> : 'Send test'}</button>
          </div>
          <hr className="sep" />
          <div className="row"><button className="btn primary" onClick={save}>Save campaign</button><button className="btn ghost" onClick={onClose}>Cancel</button></div>
        </div>
      </div>
    </Modal>
  )
}

// Bounce-check every lead in a campaign that hasn't had its first email yet,
// and pull out the ones that would bounce before they hurt an inbox.
async function checkCampaign(camp, onProgress) {
  const lower = (x) => String(x || '').trim().toLowerCase()
  const waiting = (get(KEYS.pipeline) || []).filter(l => l.seq?.campaignId === camp.id && ['queued', 'active'].includes(l.seq.status) && !(l.seq.sends || []).length && l.email)
  if (!waiting.length) return { checked: 0, bad: 0 }
  const res = await checkEmails(waiting.map(l => l.email), { onProgress })
  let bad = 0
  const now = Date.now()
  updateLeads(list => list.map(l => {
    const r = l.seq?.campaignId === camp.id && !(l.seq.sends || []).length && res[lower(l.email)]
    if (!r) return l
    const emailCheck = { email: lower(l.email), status: r.status, reason: r.reason, suggestion: r.suggestion || null, at: now }
    if (r.status === 'invalid' && ['queued', 'active'].includes(l.seq.status)) { bad++; return { ...l, emailCheck, seq: { ...l.seq, status: 'stopped', error: `Would bounce: ${r.reason}` } } }
    return { ...l, emailCheck }
  }))
  return { checked: waiting.length, bad }
}

function CheckButton({ camp }) {
  const [p, setP] = useState(null)
  const run = async () => {
    setP({ done: 0, total: 0 })
    const r = await checkCampaign(camp, (done, total) => setP({ done, total }))
    setP(null)
    toast(r.checked ? `Checked ${r.checked} emails. ${r.bad ? `${r.bad} would have bounced and were taken out.` : 'None would bounce.'}` : 'Nobody waiting for a first email in this campaign.')
  }
  return <button className="btn ghost sm" disabled={!!p} onClick={run} title="Find and remove addresses that would bounce">{p ? <><Spinner size={12} /> {p.total ? `${p.done}/${p.total}` : ''}</> : 'Check emails'}</button>
}

function AddLeads({ camp, onClose }) {
  const [pipeline] = useStore(KEYS.pipeline)
  const [cat, setCat] = useState('All')
  const [stageNew, setStageNew] = useState(true)
  const eligible = pipeline.filter(l => l.email && !l.bounced && !l.blocked && l.emailCheck?.status !== 'invalid' && !(l.seq && ['queued', 'active', 'replied'].includes(l.seq.status)) && (!stageNew || l.stage === 'New'))
  const cats = ['All', ...Array.from(new Set(eligible.map(l => l.category).filter(Boolean)))]
  const list = eligible.filter(l => cat === 'All' || l.category === cat)
  const go = () => {
    const n = enrollLeads(list.map(l => l.id), camp.id)
    toast(n ? `${n} leads added to ${camp.name}${n < list.length ? ` (${list.length - n} skipped: emailed before or blocked)` : ''}` : 'None added. They may have been emailed before.')
    onClose()
  }
  return (
    <Modal title={`Add leads to ${camp.name}`} onClose={onClose}>
      <div className="stack">
        <Field label="Category">
          <select className="select" value={cat} onChange={e => setCat(e.target.value)}>{cats.map(c => <option key={c}>{c}</option>)}</select>
        </Field>
        <label className="row small dim"><input type="checkbox" checked={stageNew} onChange={e => setStageNew(e.target.checked)} /> Only leads still in the New stage</label>
        <div className="dim">{list.length} leads with an email are ready to add. Anyone emailed before, blocked, or whose email would bounce is skipped automatically.</div>
        <div className="row"><button className="btn primary" disabled={!list.length} onClick={go}>Add {list.length} leads</button><button className="btn ghost" onClick={onClose}>Cancel</button></div>
        <div className="small muted">Tip: you can also pick exact leads in Pipeline and use “Add to campaign”.</div>
      </div>
    </Modal>
  )
}

function CampaignLeads({ stats, camp, onClose }) {
  const [filter, setFilter] = useState('all')
  const rows = stats.leads.filter(l => filter === 'all' || l.seq.status === filter)
  const remove = (id) => updateLeads(list => list.map(l => l.id === id ? { ...l, seq: { ...l.seq, status: 'stopped' } } : l))
  const retry = (id) => updateLeads(list => list.map(l => l.id === id ? { ...l, bounced: false, seq: { ...l.seq, status: (l.seq.sends || []).length ? 'active' : 'queued', attempts: 0, error: null, nextAt: Date.now() } } : l))
  return (
    <Modal title={`${camp.name}: leads`} onClose={onClose} width={900}>
      <div className="chips" style={{ marginBottom: 12 }}>
        {['all', 'queued', 'active', 'replied', 'done', 'bounced', 'stopped', 'failed'].map(f => <button key={f} className={`chip${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>{f}</button>)}
      </div>
      <div className="table-wrap" style={{ maxHeight: 480 }}>
        <table className="table">
          <thead><tr><th>Business</th><th>Status</th><th>Emails sent</th><th>Next</th><th>Inbox</th><th></th></tr></thead>
          <tbody>
            {rows.map(l => (
              <tr key={l.id}>
                <td><div style={{ fontWeight: 600 }}>{l.name}</div><div className="small muted">{l.email} {l.emailCheck && l.emailCheck.status !== 'valid' && <CheckTag status={l.emailCheck.status} reason={l.emailCheck.reason} suggestion={l.emailCheck.suggestion} />}</div></td>
                <td><span className={`tag ${l.seq.status === 'replied' ? 'ok' : l.seq.status === 'bounced' || l.seq.status === 'failed' ? 'bad' : ''}`}>{l.seq.status}</span>{l.seq.error && <div className="small muted" style={{ maxWidth: 220 }}>{l.seq.error}</div>}</td>
                <td className="num">{(l.seq.sends || []).length} / {camp.steps.length}</td>
                <td className="small dim">{['queued', 'active'].includes(l.seq.status) && l.seq.nextAt ? (l.seq.nextAt > Date.now() ? `in ${fmtIn(l.seq.nextAt)}` : 'due now') : '–'}</td>
                <td className="small dim">{l.seq.account || '–'}</td>
                <td>{['queued', 'active'].includes(l.seq.status) && <button className="btn ghost sm" onClick={() => remove(l.id)}>Stop</button>}{['failed', 'stopped'].includes(l.seq.status) && <button className="btn ghost sm" title="Put back in the queue" onClick={() => retry(l.id)}>Retry</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <Empty title="Nobody here" sub="Leads show up once they’re added to this campaign." />}
      </div>
    </Modal>
  )
}

// Shown when you press Start: pick how many cold emails each inbox sends per
// day for this run. Ticked inboxes are switched to Active with that limit;
// unticked ones send no cold email (warmup carries on as normal).
function StartCampaign({ camp, stats, onClose }) {
  const [s] = useStore(KEYS.settings)
  useStore(KEYS.accounts)
  const view = accountsView()
  // If nothing is Active yet, tick every working inbox by default. Otherwise
  // keep whatever is already sending.
  const noneActive = !view.some(a => a.status === 'active' && a.cap > 0)
  const [rows, setRows] = useState(() => view.map(a => ({
    user: a.user,
    status: a.status,
    use: (a.status === 'active' && a.cap > 0) || (noneActive && a.status !== 'paused' && a.loginOk !== false),
    cap: a.status === 'active' && a.cap > 0 ? a.cap : s.perInboxCap,
    sent: a.cold24,
    loginOk: a.loginOk,
    reason: a.meta.pausedReason,
    days: a.daysWarmed,
  })))
  const [fillAll, setFillAll] = useState('')
  const [turnOn, setTurnOn] = useState(!s.engineOn)

  const upd = (user, patch) => setRows(rs => rs.map(r => r.user === user ? { ...r, ...patch } : r))
  const usable = (r) => r.status !== 'paused' && r.loginOk !== false
  const clamp = (v) => Math.min(MAX_INBOX_CAP, Math.max(0, Math.floor(Number(v) || 0)))
  const chosen = rows.filter(r => r.use && usable(r) && r.cap > 0)
  const total = chosen.reduce((n, r) => n + r.cap, 0)
  const leftToday = chosen.reduce((n, r) => n + Math.max(0, r.cap - r.sent), 0)
  const workLeft = stats.queued * camp.steps.length + stats.active
  const days = total ? Math.ceil(workLeft / total) : null
  const high = chosen.filter(r => r.cap > 100)
  const warmingPicked = chosen.filter(r => r.status === 'warming' && r.days < 14)

  const start = () => {
    if (!chosen.length) { toast('Tick at least one inbox and give it a limit above 0'); return }
    for (const r of rows) {
      if (!usable(r)) continue
      if (r.use && r.cap > 0) {
        setInboxCap(r.user, r.cap)
        if (r.status !== 'active') setAccountMeta(r.user, { status: 'active', pausedReason: null, pausedUntil: null })
      } else if (r.status === 'active') {
        // Unticked but Active: stop its cold email by giving it a 0 limit
        setInboxCap(r.user, 0)
      }
    }
    set(KEYS.campaigns, list => list.map(x => x.id === camp.id ? { ...x, status: 'running' } : x))
    if (turnOn) set(KEYS.settings, x => ({ ...x, engineOn: true }))
    setTimeout(sendNow, 50)
    toast(`${camp.name} started: up to ${total} cold emails a day across ${chosen.length} inbox${chosen.length === 1 ? '' : 'es'}`)
    onClose()
  }

  return (
    <Modal title={`Start ${camp.name}`} onClose={onClose} width={760}>
      <div className="stack">
        <div className="small dim">
          Set how many cold emails each inbox sends per day. The engine rotates between them, always picking the inbox that has sent the least, so they fill up evenly. Follow-ups count toward the same limit, and limits are a rolling 24 hours.
        </div>

        {!rows.length && <div className="warn small">No inboxes connected. Add them in Vercel first.</div>}

        {rows.length > 0 && (
          <>
            <div className="row">
              <span className="small dim">Set all ticked to</span>
              <input className="input sm num" type="number" min={0} max={MAX_INBOX_CAP} value={fillAll} placeholder={String(s.perInboxCap)} style={{ width: 72 }} onChange={e => setFillAll(e.target.value)} />
              <button className="btn sm" onClick={() => { const n = clamp(fillAll || s.perInboxCap); setRows(rs => rs.map(r => r.use ? { ...r, cap: n } : r)) }}>Apply</button>
            </div>
            <div className="table-wrap" style={{ maxHeight: 360 }}>
              <table className="table">
                <thead><tr><th style={{ width: 40 }}>Use</th><th>Inbox</th><th style={{ width: 130 }}>Per day</th><th>Sent last 24h</th></tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.user} style={{ opacity: usable(r) ? 1 : 0.5 }}>
                      <td><input type="checkbox" disabled={!usable(r)} checked={r.use && usable(r)} onChange={e => upd(r.user, { use: e.target.checked })} aria-label={`Use ${r.user}`} /></td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.user}</div>
                        <div className="small">
                          {r.status === 'active' && <span className="ok">Active</span>}
                          {r.status === 'warming' && <span className="warmc">Warming{r.days ? `, day ${r.days}` : ''}{r.use ? ' (will switch to Active)' : ''}</span>}
                          {r.status === 'paused' && <span className="bad">Paused{r.reason ? `: ${r.reason}` : ''}</span>}
                          {r.loginOk === false && <span className="bad"> · Login failed</span>}
                        </div>
                      </td>
                      <td>
                        <input className="input sm num" type="number" min={0} max={MAX_INBOX_CAP} value={r.cap} disabled={!r.use || !usable(r)} style={{ width: 80 }}
                          onChange={e => upd(r.user, { cap: clamp(e.target.value) })} aria-label={`Daily limit for ${r.user}`} />
                      </td>
                      <td className="num dim">{r.sent}{r.use && usable(r) && r.sent >= r.cap ? <span className="small warn"> · full until tomorrow</span> : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="panel pad" style={{ background: 'rgba(0,0,0,.35)' }}>
          <div>Up to <b>{total}</b> cold emails a day from {chosen.length} inbox{chosen.length === 1 ? '' : 'es'}{total ? <span className="dim"> ({leftToday} still available right now)</span> : ''}.</div>
          {workLeft > 0 && days && <div className="small dim" style={{ marginTop: 4 }}>{workLeft} emails left in this campaign, about {days} sending day{days === 1 ? '' : 's'} at this rate.</div>}
          {high.length > 0 && <div className="small warn" style={{ marginTop: 6 }}>Over 100 a day from a single Gmail is a lot. Watch bounces and spam placement closely.</div>}
          {warmingPicked.length > 0 && <div className="small warn" style={{ marginTop: 6 }}>{warmingPicked.map(r => r.user).join(', ')} {warmingPicked.length === 1 ? 'has' : 'have'} been warming in this CRM for under 2 weeks.</div>}
        </div>

        {!s.engineOn && (
          <label className="row small dim" style={{ gap: 8 }}><input type="checkbox" checked={turnOn} onChange={e => setTurnOn(e.target.checked)} /> Also turn sending on (it’s paused right now, so nothing would go out)</label>
        )}

        <div className="row">
          <button className="btn primary" disabled={!chosen.length} onClick={start}>Start campaign</button>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  )
}

export default function CampaignsTab() {
  const [campaigns] = useStore(KEYS.campaigns)
  const [pipeline] = useStore(KEYS.pipeline)
  const [s] = useStore(KEYS.settings)
  useEngineStatus()
  const [editing, setEditing] = useState(null)
  const [adding, setAdding] = useState(null)
  const [viewing, setViewing] = useState(null)
  const [starting, setStarting] = useState(null)
  useStore(KEYS.accounts)

  const view = accountsView()
  const activeInboxes = view.filter(a => a.status === 'active' && a.cap > 0).length
  const dailyCap = activeCapacity(view)
  const sampleLead = pipeline.find(l => l.email)

  const create = () => setEditing({ id: uid(), name: '', status: 'paused', steps: JSON.parse(JSON.stringify(DEFAULT_STEPS)) })
  const toggle = (c) => {
    if (c.status === 'running') set(KEYS.campaigns, list => list.map(x => x.id === c.id ? { ...x, status: 'paused' } : x))
    else setStarting(c)
  }
  const del = (c) => {
    if (!confirm(`Delete “${c.name}”? Its leads stay in your Pipeline but stop getting emails.`)) return
    set(KEYS.campaigns, list => list.filter(x => x.id !== c.id))
    updateLeads(list => list.map(l => l.seq?.campaignId === c.id && ['queued', 'active'].includes(l.seq.status) ? { ...l, seq: { ...l.seq, status: 'stopped' } } : l))
  }
  const dup = (c) => set(KEYS.campaigns, list => [...list, { ...JSON.parse(JSON.stringify(c)), id: uid(), name: `${c.name} (copy)`, status: 'paused', createdAt: new Date().toISOString() }])

  return (
    <div className="stack">
      <div className="row">
        <div className="grow dim small">
          {activeInboxes
            ? <>Sending capacity: <b style={{ color: 'var(--text)' }}>{dailyCap}</b> cold emails a day across {activeInboxes} active inbox{activeInboxes === 1 ? '' : 'es'}, each with its own limit. Follow-ups count toward the same cap.</>
            : <span className="warn">No inbox is set to Active yet, so nothing will send. Flip them on in Inboxes &amp; Warmup once they’re warmed.</span>}
        </div>
        <button className="btn primary" onClick={create}>New campaign</button>
      </div>

      {!campaigns.length && (
        <div className="panel"><Empty title="No campaigns yet" sub="A campaign is a short email sequence. It comes pre-written for tradies, so you can edit it and go.">
          <button className="btn primary" onClick={create}>Create your first campaign</button>
        </Empty></div>
      )}

      {campaigns.map(c => {
        const st = campaignStats(c, pipeline)
        const waiting = st.queued + st.active
        const days = dailyCap ? Math.ceil((st.queued * c.steps.length + st.active) / dailyCap) : null
        return (
          <div key={c.id} className="panel">
            <div className="panel-head">
              <div className="row">
                <span className={`dot ${c.status === 'running' ? 'live' : ''}`} />
                <span className="panel-title">{c.name}</span>
                <span className="tag">{c.steps.length} emails</span>
                {c.status === 'running' ? <span className="tag ok">Running</span> : <span className="tag">Paused</span>}
              </div>
              <div className="row">
                <button className={`btn sm ${c.status === 'running' ? '' : 'primary'}`} onClick={() => toggle(c)}>{c.status === 'running' ? 'Pause' : 'Start'}</button>
                <button className="btn sm" onClick={() => setAdding(c)}>Add leads</button>
                <button className="btn sm" onClick={() => setViewing(c)}>Leads</button>
                <CheckButton camp={c} />
                <button className="btn ghost sm" onClick={() => setEditing(c)}>Edit</button>
                <button className="btn ghost sm" onClick={() => dup(c)}>Duplicate</button>
                <button className="btn ghost sm" onClick={() => del(c)}>Delete</button>
              </div>
            </div>
            <div className="pad">
              <div className="grid3" style={{ gridTemplateColumns: 'repeat(6, minmax(0,1fr))' }}>
                {[
                  ['Enrolled', st.enrolled], ['Emailed', st.contacted], ['Replied', `${st.replied}`, pct(st.replied, st.contacted)],
                  ['Positive', st.positive, pct(st.positive, st.contacted)], ['Meetings', st.meetings], ['Bounced', st.bounced, pct(st.bounced, st.contacted)],
                ].map(([l, v, sub]) => (
                  <div key={l}><div className="stat-v" style={{ fontSize: 20 }}>{v}</div><div className="stat-l">{l}{sub && sub !== '–' ? ` · ${sub}` : ''}</div></div>
                ))}
              </div>
              <div className="small muted" style={{ marginTop: 14 }}>
                {waiting ? `${waiting} lead${waiting === 1 ? '' : 's'} still in the sequence${days ? `, roughly ${days} sending day${days === 1 ? '' : 's'} to get through them at full capacity` : ''}.` : 'No one waiting. Add leads to keep it going.'}
                {c.status !== 'running' && waiting > 0 && <span className="warn"> Paused, so none of them are sending.</span>}
              </div>
            </div>
          </div>
        )
      })}

      {editing && <Editor camp={editing} sampleLead={sampleLead} onClose={() => setEditing(null)} />}
      {adding && <AddLeads camp={adding} onClose={() => setAdding(null)} />}
      {starting && <StartCampaign camp={starting} stats={campaignStats(starting, pipeline)} onClose={() => setStarting(null)} />}
      {viewing && <CampaignLeads camp={viewing} stats={campaignStats(viewing, pipeline)} onClose={() => setViewing(null)} />}
    </div>
  )
}

export { campaignStats }
