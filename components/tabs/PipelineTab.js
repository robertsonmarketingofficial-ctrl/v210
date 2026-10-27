import { useMemo, useState } from 'react'
import { useStore, KEYS, STAGES, patchLead, updateLeads, newLead, uid } from '../store'
import { enrollLeads } from '../engine'
import { leadState, leadSuburb } from '../templating'
import { Drawer, Modal, Empty, Field, Spinner, toast, fmtWhen, fmtIn, downloadFile, toCSV, CATEGORIES, CheckTag } from '../ui'
import { checkEmails } from '../verifyClient'
import { hasBeenContacted } from '../tracker'

const SEQ_LABEL = { queued: 'Queued', active: 'In sequence', replied: 'Replied', done: 'Sequence done', bounced: 'Bounced', stopped: 'Stopped', failed: 'Failed' }
const SEQ_TONE = { queued: 'bolt', active: 'bolt', replied: 'ok', bounced: 'bad', failed: 'bad' }
const PAGE = 150

export function SeqTag({ lead }) {
  if (lead.bounced && lead.seq?.status !== 'bounced') return <span className="tag bad">Bounced</span>
  if (!lead.seq) return <span className="small muted">Not in a campaign</span>
  const st = lead.seq.status
  return <span className={`tag ${SEQ_TONE[st] || ''}`}>{SEQ_LABEL[st] || st}{st === 'active' ? ` · ${(lead.seq.sends || []).length} sent` : ''}</span>
}

function LeadDrawer({ id, onClose, setTab }) {
  const [pipeline] = useStore(KEYS.pipeline)
  const [inbox] = useStore(KEYS.inbox)
  const [campaigns] = useStore(KEYS.campaigns)
  const lead = pipeline.find(l => l.id === id)
  if (!lead) return null
  const camp = campaigns.find(c => c.id === lead.seq?.campaignId)
  const timeline = [
    ...(lead.seq?.sends || []).map(s => ({ at: s.at, me: true, subject: s.subject, text: s.text, account: s.account })),
    ...(lead.manualSends || []).map(s => ({ at: s.at, me: true, subject: s.subject, text: s.text, account: s.account })),
    ...(inbox.messages || []).filter(m => m.leadId === lead.id).map(m => ({ at: new Date(m.date).getTime(), me: false, subject: m.subject, text: m.text, account: m.account, kind: m.kind })),
  ].sort((a, b) => a.at - b.at)

  return (
    <Drawer title={lead.name} onClose={onClose}>
      <div className="stack">
        <div className="row">
          {lead.website && <a className="btn sm" href={lead.website} target="_blank" rel="noreferrer">Website</a>}
          {lead.address && <a className="btn sm" href={`https://maps.google.com/?q=${encodeURIComponent(lead.name + ' ' + lead.address)}`} target="_blank" rel="noreferrer">Google Maps</a>}
          {lead.rating && <span className={`tag ${lead.rating < 4 ? 'warn' : ''}`}>{lead.rating}★ from {lead.reviewCount || 0} reviews</span>}
        </div>
        <div className="grid2">
          <Field label="Email">
            <input className="input" value={lead.email || ''} onChange={e => patchLead(lead.id, { email: e.target.value.trim().toLowerCase(), bounced: false, emailCheck: null })} placeholder="No email found" />
            {lead.emailCheck && lead.emailCheck.email === String(lead.email || '').toLowerCase() && (
              <div className="row small" style={{ marginTop: 6, gap: 6 }}>
                <CheckTag status={lead.emailCheck.status} reason={lead.emailCheck.reason} suggestion={lead.emailCheck.suggestion} />
                <span className="muted">{lead.emailCheck.reason}</span>
                {lead.emailCheck.suggestion && <button className="btn ghost sm" onClick={() => patchLead(lead.id, { email: lead.emailCheck.suggestion, emailCheck: null, bounced: false })}>Use {lead.emailCheck.suggestion}</button>}
              </div>
            )}
          </Field>
          <Field label="Stage">
            <select className="select" value={lead.stage} onChange={e => patchLead(lead.id, { stage: e.target.value })}>{STAGES.map(s => <option key={s}>{s}</option>)}</select>
          </Field>
        </div>
        <div className="small dim">{[lead.category, leadSuburb(lead), leadState(lead)].filter(Boolean).join(', ')}{lead.address ? ` — ${lead.address}` : ''}</div>
        <Field label="Notes"><textarea className="textarea" rows={3} style={{ minHeight: 70 }} value={lead.notes || ''} onChange={e => patchLead(lead.id, { notes: e.target.value })} placeholder="Anything worth remembering" /></Field>
        <div className="row">
          <SeqTag lead={lead} />
          {camp && <span className="small dim">{camp.name}</span>}
          {lead.seq && ['queued', 'active'].includes(lead.seq.status) && lead.seq.nextAt && <span className="small muted">next email {lead.seq.nextAt > Date.now() ? `in ${fmtIn(lead.seq.nextAt)}` : 'when the engine next sends'}</span>}
          {lead.seq && ['queued', 'active'].includes(lead.seq.status) && <button className="btn ghost sm" onClick={() => patchLead(lead.id, l => ({ seq: { ...l.seq, status: 'stopped' } }))}>Stop sequence</button>}
        </div>
        <hr className="sep" />
        <div className="row"><div className="panel-title grow">Conversation</div>{timeline.some(t => !t.me) && <button className="btn sm" onClick={() => { onClose(); setTab('inbox') }}>Reply in Inbox</button>}</div>
        {!timeline.length && <div className="muted small">No emails yet.</div>}
        {timeline.map((t, i) => (
          <div key={i} className={`bubble ${t.me ? 'me' : 'them'}`}>
            <div className="bubble-meta">{t.me ? `You, from ${t.account}` : t.kind === 'bounce' ? 'Bounce notice' : t.kind === 'auto' ? 'Auto-reply' : lead.name} · {new Date(t.at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} · {t.subject}</div>
            {t.text}
          </div>
        ))}
      </div>
    </Drawer>
  )
}

function QuickAdd({ onClose }) {
  const [f, setF] = useState({ name: '', email: '', category: 'Plumber', address: '', website: '' })
  const add = () => {
    if (!f.name.trim()) return
    updateLeads(list => [...list, newLead({ id: `manual-${uid()}`, ...f, name: f.name.trim(), email: f.email.trim() })])
    toast(`${f.name} added`)
    onClose()
  }
  return (
    <Modal title="Add a lead" onClose={onClose} width={520}>
      <div className="stack">
        <Field label="Business name"><input className="input" autoFocus value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email"><input className="input" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
        <div className="grid2">
          <Field label="Category"><input className="input" list="cats" value={f.category} onChange={e => setF({ ...f, category: e.target.value })} /><datalist id="cats">{CATEGORIES.map(c => <option key={c} value={c} />)}</datalist></Field>
          <Field label="Website"><input className="input" value={f.website} onChange={e => setF({ ...f, website: e.target.value })} /></Field>
        </div>
        <Field label="Address (suburb + state is enough)"><input className="input" value={f.address} onChange={e => setF({ ...f, address: e.target.value })} placeholder="Salisbury SA" /></Field>
        <div className="row"><button className="btn primary" disabled={!f.name.trim()} onClick={add}>Add lead</button><button className="btn ghost" onClick={onClose}>Cancel</button></div>
      </div>
    </Modal>
  )
}

// CSV import: needs a name column and an email column (any order, any case).
function parseCSV(text) {
  const rows = []
  let row = [], cur = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++ } else if (c === '"') q = false; else cur += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(cur); cur = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = '' }
    else cur += c
  }
  if (cur || row.length) { row.push(cur); rows.push(row) }
  return rows.filter(r => r.some(v => v.trim()))
}

export default function PipelineTab({ setTab }) {
  const [pipeline] = useStore(KEYS.pipeline)
  const [campaigns] = useStore(KEYS.campaigns)
  const [q, setQ] = useState('')
  const [stage, setStage] = useState('All')
  const [cat, setCat] = useState('All')
  const [st, setSt] = useState('All')
  const [seq, setSeq] = useState('All')
  const [emailOnly, setEmailOnly] = useState(false)
  const [chk, setChk] = useState('All')
  const [checking, setChecking] = useState(null)
  const [maxRating, setMaxRating] = useState(0)
  const [sel, setSel] = useState(new Set())
  const [open, setOpen] = useState(null)
  const [adding, setAdding] = useState(false)
  const [limit, setLimit] = useState(PAGE)
  const [campPick, setCampPick] = useState('')

  const cats = useMemo(() => ['All', ...Array.from(new Set(pipeline.map(l => l.category).filter(Boolean))).sort()], [pipeline])
  const states = useMemo(() => ['All', ...['SA', 'VIC', 'NSW', 'QLD', 'WA', 'TAS', 'ACT', 'NT'].filter(s => pipeline.some(l => leadState(l) === s))], [pipeline])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return pipeline.filter(l =>
      (stage === 'All' || l.stage === stage) &&
      (cat === 'All' || l.category === cat) &&
      (st === 'All' || leadState(l) === st) &&
      (!emailOnly || l.email) &&
      (chk === 'All' || (chk === 'unchecked' ? l.email && !l.emailCheck : l.emailCheck?.status === chk)) &&
      (!maxRating || (l.rating && l.rating < maxRating)) &&
      (seq === 'All' || (seq === 'none' ? !l.seq : l.seq?.status === seq)) &&
      (!needle || [l.name, l.email, l.address, l.category].some(v => String(v || '').toLowerCase().includes(needle)))
    ).sort((a, b) => new Date(b.lastReplyAt || b.addedAt || 0) - new Date(a.lastReplyAt || a.addedAt || 0))
  }, [pipeline, q, stage, cat, st, emailOnly, maxRating, seq, chk])

  const toggle = (id) => setSel(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allOn = filtered.length > 0 && filtered.every(l => sel.has(l.id))
  const clear = () => setSel(new Set())

  const addToCampaign = () => {
    const camp = campaigns.find(c => c.id === campPick) || campaigns[0]
    if (!camp) { toast('Create a campaign first'); setTab('campaigns'); return }
    const n = enrollLeads([...sel], camp.id)
    const skipped = sel.size - n
    toast(`${n} added to ${camp.name}${skipped ? ` (${skipped} skipped: no email, already emailed, or already in a sequence)` : ''}`)
    clear()
  }
  const checkBulk = async () => {
    const lower = (x) => String(x || '').trim().toLowerCase()
    const picked = pipeline.filter(l => sel.has(l.id) && l.email)
    if (!picked.length) return toast('None of those have an email')
    setChecking({ done: 0, total: picked.length })
    const res = await checkEmails(picked.map(l => l.email), { force: true, onProgress: (done, total) => setChecking({ done, total }) })
    let bad = 0
    updateLeads(list => list.map(l => {
      const r = sel.has(l.id) && l.email && res[lower(l.email)]
      if (!r) return l
      if (r.status === 'invalid') bad++
      const emailCheck = { email: lower(l.email), status: r.status, reason: r.reason, suggestion: r.suggestion || null, at: Date.now() }
      const stop = r.status === 'invalid' && l.seq && ['queued', 'active'].includes(l.seq.status) && !(l.seq.sends || []).length
      return { ...l, emailCheck, seq: stop ? { ...l.seq, status: 'stopped', error: `Would bounce: ${r.reason}` } : l.seq }
    }))
    setChecking(null)
    toast(`Checked ${picked.length}. ${bad ? `${bad} would bounce (filter by “Would bounce” to see them).` : 'All good.'}`)
  }
  const setStageBulk = (s) => { updateLeads(list => list.map(l => sel.has(l.id) ? { ...l, stage: s } : l)); toast(`${sel.size} moved to ${s}`); clear() }
  const stopBulk = () => { updateLeads(list => list.map(l => sel.has(l.id) && l.seq && ['queued', 'active'].includes(l.seq.status) ? { ...l, seq: { ...l.seq, status: 'stopped' } } : l)); toast('Sequences stopped'); clear() }
  const delBulk = () => { if (!confirm(`Delete ${sel.size} leads? This can’t be undone (unless you have a backup).`)) return; updateLeads(list => list.filter(l => !sel.has(l.id))); toast('Deleted'); clear() }
  const exportRows = (rows, name) => downloadFile(name, toCSV(rows, [
    { label: 'Name', key: 'name' }, { label: 'Email', key: 'email' }, { label: 'Category', key: 'category' },
    { label: 'Suburb', get: leadSuburb }, { label: 'State', get: leadState }, { label: 'Website', key: 'website' },
    { label: 'Rating', key: 'rating' }, { label: 'Reviews', key: 'reviewCount' }, { label: 'Stage', key: 'stage' },
    { label: 'Sequence', get: l => l.seq?.status || '' }, { label: 'Notes', key: 'notes' }, { label: 'Address', key: 'address' },
  ]), 'text/csv')

  const importCSV = (e) => {
    const file = e.target.files?.[0]; if (!file) return
    const r = new FileReader()
    r.onload = () => {
      const rows = parseCSV(String(r.result))
      if (rows.length < 2) { toast('That file looks empty'); return }
      const head = rows[0].map(h => h.trim().toLowerCase())
      const col = (...names) => head.findIndex(h => names.some(n => h.includes(n)))
      const iName = col('name', 'business', 'company'), iEmail = col('email'), iCat = col('category', 'niche', 'trade'), iAddr = col('address', 'suburb', 'location'), iWeb = col('website', 'url')
      if (iName < 0 || iEmail < 0) { toast('Need a “name” column and an “email” column'); return }
      const existing = new Set(pipeline.map(l => String(l.email || '').toLowerCase()).filter(Boolean))
      const fresh = rows.slice(1).map(c => ({ name: c[iName]?.trim(), email: String(c[iEmail] || '').trim().toLowerCase(), category: iCat >= 0 ? c[iCat]?.trim() : '', address: iAddr >= 0 ? c[iAddr]?.trim() : '', website: iWeb >= 0 ? c[iWeb]?.trim() : '' }))
        .filter(l => l.name && l.email && !existing.has(l.email) && (existing.add(l.email), true))
        .map(l => newLead({ id: `csv-${uid()}`, ...l }))
      updateLeads(list => [...list, ...fresh])
      const before = fresh.filter(l => hasBeenContacted(l.email)).length
      toast(`Imported ${fresh.length} leads (duplicates skipped)${before ? `. ${before} were emailed before and won’t get a first email again.` : ''}`)
    }
    r.readAsText(file); e.target.value = ''
  }

  const counts = useMemo(() => Object.fromEntries(STAGES.map(s => [s, pipeline.filter(l => l.stage === s).length])), [pipeline])

  return (
    <div className="stack">
      <div className="row">
        <input className="input" style={{ maxWidth: 280 }} placeholder="Search name, email, suburb" value={q} onChange={e => { setQ(e.target.value); setLimit(PAGE) }} />
        <select className="select sm" value={cat} onChange={e => setCat(e.target.value)} aria-label="Category">{cats.map(c => <option key={c} value={c}>{c === 'All' ? 'All categories' : c}</option>)}</select>
        {states.length > 2 && <select className="select sm" value={st} onChange={e => setSt(e.target.value)} aria-label="State">{states.map(c => <option key={c} value={c}>{c === 'All' ? 'All states' : c}</option>)}</select>}
        <select className="select sm" value={seq} onChange={e => setSeq(e.target.value)} aria-label="Sequence">
          <option value="All">Any sequence status</option><option value="none">Not in a campaign</option>
          {Object.entries(SEQ_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="select sm" value={maxRating} onChange={e => setMaxRating(Number(e.target.value))} aria-label="Rating">
          <option value={0}>Any rating</option><option value={4.5}>Below 4.5★</option><option value={4}>Below 4★</option><option value={3.5}>Below 3.5★</option>
        </select>
        <select className="select sm" value={chk} onChange={e => setChk(e.target.value)} aria-label="Email check">
          <option value="All">Any email check</option><option value="valid">Deliverable</option><option value="invalid">Would bounce</option><option value="unknown">Couldn’t check</option><option value="unchecked">Not checked yet</option>
        </select>
        <label className="row small dim" style={{ gap: 6 }}><input type="checkbox" checked={emailOnly} onChange={e => setEmailOnly(e.target.checked)} /> Has email</label>
        <div className="grow" />
        <label className="btn sm" style={{ cursor: 'pointer' }}>Import CSV<input type="file" accept=".csv" onChange={importCSV} style={{ display: 'none' }} /></label>
        <button className="btn sm" onClick={() => exportRows(filtered, 'robertson-leads.csv')}>Export</button>
        <button className="btn sm primary" onClick={() => setAdding(true)}>Add lead</button>
      </div>
      <div className="chips">
        {['All', ...STAGES].map(s => <button key={s} className={`chip${stage === s ? ' on' : ''}`} onClick={() => setStage(s)}>{s}{s !== 'All' ? ` ${counts[s] || 0}` : ` ${pipeline.length}`}</button>)}
      </div>

      <div className="panel">
        {!pipeline.length ? (
          <Empty title="Your pipeline is empty" sub="Find leads in Lead Finder or AFK Hunter, or import a CSV."><button className="btn primary" onClick={() => setTab('finder')}>Find leads</button></Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>
                <th style={{ width: 34 }}><input type="checkbox" checked={allOn} onChange={e => setSel(e.target.checked ? new Set(filtered.map(l => l.id)) : new Set())} aria-label="Select all" /></th>
                <th>Business</th><th>Email</th><th>Rating</th><th>Stage</th><th>Campaign</th><th>Activity</th>
              </tr></thead>
              <tbody>
                {filtered.slice(0, limit).map(l => (
                  <tr key={l.id} className={sel.has(l.id) ? 'sel' : ''}>
                    <td><input type="checkbox" checked={sel.has(l.id)} onChange={() => toggle(l.id)} aria-label={`Select ${l.name}`} /></td>
                    <td><div className="cell-name" onClick={() => setOpen(l.id)}>{l.name}</div><div className="small muted">{[l.category, leadSuburb(l), leadState(l)].filter(Boolean).join(', ')}</div></td>
                    <td className="small">{l.email ? <><span className={l.bounced ? 'bad' : 'dim'}>{l.email}</span>{l.emailCheck?.status === 'invalid' && l.emailCheck.email === String(l.email).toLowerCase() && <> <CheckTag status="invalid" reason={l.emailCheck.reason} suggestion={l.emailCheck.suggestion} /></>}{l.blocked && <> <span className="tag warn" title={l.blocked}>Blocked</span></>}</> : <span className="muted">none</span>}</td>
                    <td className={`small num ${l.rating && l.rating < 4 ? 'warn' : 'dim'}`}>{l.rating ? `${l.rating}★ (${l.reviewCount || 0})` : '–'}</td>
                    <td><select className="select sm" value={l.stage} onChange={e => patchLead(l.id, { stage: e.target.value })} aria-label="Stage">{STAGES.map(s => <option key={s}>{s}</option>)}</select></td>
                    <td><SeqTag lead={l} /></td>
                    <td className="small muted">{l.lastReplyAt ? <span className="ok">replied {fmtWhen(l.lastReplyAt)}</span> : l.seq?.sends?.length ? `emailed ${fmtWhen(l.seq.sends[l.seq.sends.length - 1].at)}` : `added ${fmtWhen(l.addedAt)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length > limit && <div className="pad" style={{ textAlign: 'center' }}><button className="btn sm" onClick={() => setLimit(x => x + PAGE)}>Show more ({filtered.length - limit} left)</button></div>}
            {!filtered.length && <Empty title="No leads match these filters" sub="Clear a filter or two." />}
          </div>
        )}
      </div>

      {sel.size > 0 && (
        <div className="bulk">
          <b>{sel.size} selected</b>
          <select className="select sm" value={campPick} onChange={e => setCampPick(e.target.value)} aria-label="Campaign">
            {campaigns.length ? campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>) : <option value="">No campaigns yet</option>}
          </select>
          <button className="btn primary sm" onClick={addToCampaign}>Add to campaign</button>
          <select className="select sm" value="" onChange={e => e.target.value && setStageBulk(e.target.value)} aria-label="Move to stage">
            <option value="">Move to stage…</option>{STAGES.map(s => <option key={s}>{s}</option>)}
          </select>
          <button className="btn sm" disabled={!!checking} onClick={checkBulk}>{checking ? <><Spinner size={12} /> {checking.done}/{checking.total}</> : 'Check emails'}</button>
          <button className="btn sm" onClick={stopBulk}>Stop sequences</button>
          <button className="btn sm" onClick={() => exportRows(pipeline.filter(l => sel.has(l.id)), 'selected-leads.csv')}>Export</button>
          <button className="btn danger sm" onClick={delBulk}>Delete</button>
          <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={clear}>Clear</button>
        </div>
      )}

      {open && <LeadDrawer id={open} onClose={() => setOpen(null)} setTab={setTab} />}
      {adding && <QuickAdd onClose={() => setAdding(false)} />}
    </div>
  )
}
