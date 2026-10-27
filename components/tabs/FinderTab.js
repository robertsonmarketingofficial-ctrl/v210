import { useMemo, useState } from 'react'
import { useStore, KEYS, updateLeads, newLead } from '../store'
import { enrollLeads } from '../engine'
import { useJobs, startSearch, startSweep, stopJob, removeJob, resumeJob, recheckJob, clearFinished, splitList, REGIONS, checkFor } from '../jobs'
import { leadSuburb, leadState } from '../templating'
import { Spinner, Empty, toast, downloadFile, toCSV, CATEGORIES, CheckTag, usePersisted } from '../ui'

const lower = (s) => String(s || '').trim().toLowerCase()
const PAGE = 200
const FORM = 'rm_finder_form'


const STATUS = {
  queued: ['Waiting', ''], running: ['Searching', 'bolt'], checking: ['Checking emails', 'bolt'], stopping: ['Stopping', 'warn'],
  done: ['Done', 'ok'], stopped: ['Stopped', 'warn'], failed: ['Failed', 'bad'], interrupted: ['Interrupted', 'warn'],
}
const isLive = (j) => ['queued', 'running', 'checking', 'stopping'].includes(j.status)


function JobRow({ j, viewing, onView }) {
  const [label, tone] = STATUS[j.status] || [j.status, '']
  const pct = j.progress.total ? (j.progress.done / j.progress.total) * 100 : 0
  return (
    <div className={`job-row${viewing ? ' on' : ''}`}>
      <div className="row" style={{ flexWrap: 'nowrap', gap: 10 }}>
        <input type="checkbox" checked={viewing} onChange={onView} aria-label={`Show results from ${j.label}`} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.label}</b>
            <span className={`tag ${tone}`}>{isLive(j) && j.status !== 'stopping' && <Spinner size={10} />} {label}</span>
          </div>
          <div className="small muted" style={{ marginTop: 3 }}>
            {j.progress.total > 1 && <>{j.progress.done}/{j.progress.total} suburbs · </>}
            {j.tally.found} found · <span className="dim">{j.results.filter(r => r.email).length} with email</span>
            {j.scrape.total > 0 && j.scrape.done < j.scrape.total && <> · checking websites {j.scrape.done}/{j.scrape.total}</>}
            {j.status === 'checking' && <> · bounce check {j.check.done}/{j.check.total}</>}
            {j.tally.invalid > 0 && <> · <span className="bad">{j.tally.invalid} would bounce</span></>}
            {j.tally.blocked > 0 && <> · {j.tally.blocked} councils/gov/etc removed</>}
            {j.progress.current && isLive(j) && <> · now: {j.progress.current}</>}
            {j.resultsDropped && <> · <span className="warn">results cleared to save space</span></>}
          </div>
          {j.error && <div className="small bad">{j.error}</div>}
          {j.progress.total > 1 && <div className="bar" style={{ marginTop: 6 }}><span className="c" style={{ width: `${pct}%` }} /></div>}
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          {isLive(j) && j.status !== 'stopping' && <button className="btn sm danger" onClick={() => stopJob(j.id)}>Stop</button>}
          {['stopped', 'interrupted', 'failed'].includes(j.status) && j.progress.done < j.progress.total && <button className="btn sm" onClick={() => resumeJob(j.id)}>Resume</button>}
          {!isLive(j) && j.results.some(r => r.email) && <button className="btn ghost sm" title="Run the bounce check again" onClick={() => recheckJob(j.id)}>Re-check</button>}
          <button className="btn ghost sm" aria-label="Remove" onClick={() => removeJob(j.id)}>✕</button>
        </div>
      </div>
    </div>
  )
}

export default function FinderTab({ setTab }) {
  const [pipeline] = useStore(KEYS.pipeline)
  const [campaigns] = useStore(KEYS.campaigns)
  const [s] = useStore(KEYS.settings)
  useStore(KEYS.verify)
  const jobs = useJobs().filter(j => j.kind !== 'hunt')

  const [trades, setTrades] = usePersisted(FORM, 'trades', 'Plumber')
  const [places, setPlaces] = usePersisted(FORM, 'places', '')
  const [sweeps, setSweeps] = usePersisted(FORM, 'sweeps', [{ trade: 'Tree service', region: 'SA' }])
  const [pages, setPages] = usePersisted(FORM, 'pages', s.searchPages || 3)
  const [hiddenList, setHiddenList] = usePersisted(FORM, 'hidden', []) // job ids NOT shown in results
  const hidden = useMemo(() => new Set(hiddenList), [hiddenList])
  const setHidden = (fn) => setHiddenList(prev => [...(typeof fn === 'function' ? fn(new Set(prev)) : fn)])
  const [f, setF] = usePersisted(FORM, 'filters', { emailOnly: true, hideHeld: true, hideBad: true, hideBefore: true, maxRating: 0, q: '' })
  const [sel, setSel] = useState(new Set())
  const [campPick, setCampPick] = useState('')
  const [limit, setLimit] = useState(PAGE)

  const held = useMemo(() => new Map(pipeline.map(l => [l.id, l])), [pipeline])

  const search = () => {
    const ts = splitList(trades), ls = splitList(places)
    if (!ts.length) return toast('Type at least one trade')
    if (!ls.length) return toast('Type at least one suburb (one per line or comma-separated)')
    if (ts.length * ls.length > 40) return toast(`That's ${ts.length * ls.length} searches. Keep it under 40, or use a state sweep.`)
    for (const t of ts) for (const l of ls) startSearch({ category: t, location: l, pages })
    toast(`Started ${ts.length * ls.length} search${ts.length * ls.length === 1 ? '' : 'es'}. They keep running if you switch tabs.`)
  }
  // Each row is its own sweep: e.g. Tree service across SA + Plumber across NSW
  const sweepAll = () => {
    const rows = sweeps.filter(r => r.trade.trim())
    if (!rows.length) return toast('Type a trade in at least one row')
    let n = 0
    for (const r of rows) for (const t of splitList(r.trade)) { startSweep({ category: t, region: r.region, pages }); n++ }
    toast(`Started ${n} sweep${n === 1 ? '' : 's'} at once. They keep running if you switch tabs.`)
  }
  const setRow = (i, patch) => setSweeps(rows => rows.map((r, j) => j === i ? { ...r, ...patch } : r))

  // Results from every ticked job, de-duplicated
  const results = useMemo(() => {
    const map = new Map()
    for (const j of jobs) if (!hidden.has(j.id)) for (const r of j.results) if (!map.has(r.id) || (r.email && !map.get(r.id).email)) map.set(r.id, r)
    return [...map.values()]
  }, [jobs, hidden])

  const q = lower(f.q)
  const shown = results.filter(l => {
    const check = checkFor(l)
    if (f.emailOnly && !l.email) return false
    if (f.hideHeld && held.has(l.id)) return false
    if (f.hideBad && check === 'invalid') return false
    if (f.hideBefore && l.contactedBefore) return false
    if (f.maxRating && !(l.rating && l.rating < f.maxRating)) return false
    if (q && ![l.name, l.email, l.address, l.category].some(x => lower(x).includes(q))) return false
    return true
  })

  const addSelected = (andCampaign) => {
    const picked = results.filter(l => sel.has(l.id))
    if (!picked.length) return
    const now = Date.now()
    let fresh = 0, updated = 0
    updateLeads(list => {
      const byId = new Map(list.map(l => [l.id, l]))
      const out = list.map(l => {
        const r = picked.find(p => p.id === l.id)
        // Already held but had no email: fill in the one we just found
        if (r && r.email && !l.email) { updated++; return { ...l, email: r.email, emailCheck: r.check ? { email: lower(r.email), status: r.check, reason: r.checkReason, at: now } : l.emailCheck } }
        return l
      })
      for (const r of picked) if (!byId.has(r.id)) {
        fresh++
        out.push(newLead({ ...r, emailCheck: r.check ? { email: lower(r.email), status: r.check, reason: r.checkReason, at: now } : undefined }))
      }
      return out
    })
    let msg = `${fresh} added to pipeline${updated ? `, ${updated} existing leads got an email` : ''}`
    if (andCampaign) {
      const camp = campaigns.find(c => c.id === campPick) || campaigns[0]
      if (!camp) { toast('Create a campaign first'); setTab('campaigns'); return }
      const n = enrollLeads(picked.map(l => l.id), camp.id)
      msg += `, ${n} queued in ${camp.name}`
      if (n < picked.length) msg += ` (${picked.length - n} skipped: no email, would bounce, blocked or emailed before)`
    }
    toast(msg)
    setSel(new Set())
  }

  const exportCSV = () => downloadFile('lead-finder.csv', toCSV(shown, [
    { label: 'Name', key: 'name' }, { label: 'Trade', key: 'category' }, { label: 'Email', key: 'email' },
    { label: 'Email check', get: l => checkFor(l) || '' }, { label: 'Phone', key: 'phone' }, { label: 'Website', key: 'website' },
    { label: 'Rating', key: 'rating' }, { label: 'Reviews', key: 'reviewCount' }, { label: 'Suburb', get: l => leadSuburb(l) },
    { label: 'State', get: l => leadState(l) || '' }, { label: 'Address', key: 'address' },
  ]), 'text/csv')

  const allOn = shown.length > 0 && shown.slice(0, limit).every(l => sel.has(l.id))
  const live = jobs.filter(isLive).length
  const setFilter = (k) => (e) => setF(x => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  return (
    <div className="stack">
      <div className="panel pad stack">
        <div className="grid2" style={{ alignItems: 'start' }}>
          <label><span className="label">Trades <span className="muted">(comma-separated to run several)</span></span>
            <input className="input" list="trade-list" value={trades} onChange={e => setTrades(e.target.value)} placeholder="Plumber, Roofer, Electrician" />
            <datalist id="trade-list">{CATEGORIES.map(c => <option key={c} value={c} />)}</datalist>
          </label>
          <label><span className="label">Suburbs <span className="muted">(one per line or comma-separated)</span></span>
            <textarea className="input" rows={2} value={places} onChange={e => setPlaces(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) search() }} placeholder={'Salisbury SA\nElizabeth SA, Gawler SA'} />
          </label>
        </div>
        <div className="row">
          <button className="btn primary" onClick={search}>Search {splitList(trades).length * splitList(places).length > 1 ? `(${splitList(trades).length * splitList(places).length} searches)` : ''}</button>
          <div className="grow" />
          <label className="row small dim" style={{ gap: 6 }}>Results per suburb
            <select className="select sm" value={pages} onChange={e => setPages(Number(e.target.value))}><option value={1}>up to 20</option><option value={2}>up to 40</option><option value={3}>up to 60</option></select>
          </label>
        </div>
        <hr className="sep" />
        <div className="label">Sweep whole states <span className="muted">(each row runs at the same time, e.g. tree service across SA and plumbers across NSW)</span></div>
        {sweeps.map((r, i) => (
          <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="input" list="trade-list" style={{ flex: 2 }} value={r.trade} onChange={e => setRow(i, { trade: e.target.value })} placeholder="Trade" aria-label={`Sweep ${i + 1} trade`} />
            <span className="small muted">across</span>
            <select className="select" style={{ flex: 1.4 }} value={r.region} onChange={e => setRow(i, { region: e.target.value })} aria-label={`Sweep ${i + 1} region`}>{REGIONS.map(x => <option key={x.short} value={x.short}>{x.label}</option>)}</select>
            {sweeps.length > 1 && <button className="btn ghost sm" aria-label="Remove row" onClick={() => setSweeps(rows => rows.filter((_, j) => j !== i))}>✕</button>}
          </div>
        ))}
        <div className="row">
          <button className="btn" onClick={sweepAll}>Start {sweeps.filter(r => r.trade.trim()).length > 1 ? `all ${sweeps.filter(r => r.trade.trim()).length} sweeps` : 'sweep'}</button>
          <button className="btn ghost sm" onClick={() => setSweeps(rows => [...rows, { trade: '', region: rows[rows.length - 1]?.region === 'SA' ? 'NSW' : 'SA' }])}>+ Add another</button>
        </div>
        <div className="small muted">Searches run in the background. Switch to any tab and they keep going. Councils, SES, government, schools and the like are removed automatically, and every email found is checked for bounces.</div>
      </div>

      {jobs.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <div className="panel-title">Searches {live > 0 && <span className="small muted">({live} running)</span>}</div>
            <div className="row">
              <button className="btn ghost sm" onClick={() => setHidden(new Set())}>Show all</button>
              <button className="btn ghost sm" onClick={() => setHidden(new Set(jobs.map(j => j.id)))}>Hide all</button>
              <button className="btn ghost sm" onClick={clearFinished}>Clear finished</button>
            </div>
          </div>
          <div className="jobs">
            {jobs.map(j => <JobRow key={j.id} j={j} viewing={!hidden.has(j.id)} onView={() => setHidden(h => { const n = new Set(h); n.has(j.id) ? n.delete(j.id) : n.add(j.id); return n })} />)}
          </div>
        </div>
      )}

      {results.length > 0 && (
        <div className="panel pad row" style={{ gap: 14 }}>
          <span className="small dim num">{results.length} found · <b style={{ color: 'var(--text)' }}>{results.filter(r => r.email).length}</b> with email · {shown.length} shown</span>
          <div className="grow" />
          <input className="input sm" style={{ width: 180 }} placeholder="Filter by name, suburb…" value={f.q} onChange={setFilter('q')} />
          <label className="row small dim" style={{ gap: 6 }}><input type="checkbox" checked={f.emailOnly} onChange={setFilter('emailOnly')} /> Only with email</label>
          <label className="row small dim" style={{ gap: 6 }}><input type="checkbox" checked={f.hideBad} onChange={setFilter('hideBad')} /> Hide would-bounce</label>
          <label className="row small dim" style={{ gap: 6 }}><input type="checkbox" checked={f.hideBefore} onChange={setFilter('hideBefore')} /> Hide emailed before</label>
          <label className="row small dim" style={{ gap: 6 }}><input type="checkbox" checked={f.hideHeld} onChange={setFilter('hideHeld')} /> Hide ones I have</label>
          <select className="select sm" value={f.maxRating} onChange={e => setF(x => ({ ...x, maxRating: Number(e.target.value) }))} aria-label="Rating"><option value={0}>Any rating</option><option value={4.5}>Below 4.5★</option><option value={4}>Below 4★</option><option value={3.5}>Below 3.5★</option></select>
          <button className="btn sm" disabled={!shown.length} onClick={exportCSV}>Export</button>
        </div>
      )}

      <div className="panel">
        {!jobs.length && <Empty title="Search for trades in some suburbs" sub="Type a few trades and suburbs to run them all at once, or sweep a whole state. Results get their websites checked for an email and every email gets a bounce check." />}
        {jobs.length > 0 && !results.length && <Empty title={live ? 'Searching…' : 'No results yet'} sub={live ? 'Results appear here as each suburb comes back.' : 'Tick a search above to see its results.'} />}
        {results.length > 0 && !shown.length && <Empty title="Nothing matches these filters" sub="Untick some filters to see more." />}
        {shown.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>
                <th style={{ width: 34 }}><input type="checkbox" checked={allOn} onChange={e => setSel(e.target.checked ? new Set(shown.slice(0, limit).map(l => l.id)) : new Set())} aria-label="Select all shown" /></th>
                <th>Business</th><th>Email</th><th>Rating</th><th>Links</th><th></th>
              </tr></thead>
              <tbody>
                {shown.slice(0, limit).map(l => {
                  const check = checkFor(l)
                  return (
                    <tr key={l.id} className={sel.has(l.id) ? 'sel' : ''}>
                      <td><input type="checkbox" checked={sel.has(l.id)} onChange={() => setSel(p => { const n = new Set(p); n.has(l.id) ? n.delete(l.id) : n.add(l.id); return n })} aria-label={`Select ${l.name}`} /></td>
                      <td><div style={{ fontWeight: 600 }}>{l.name}</div><div className="small muted">{l.category} · {[leadSuburb(l), leadState(l)].filter(Boolean).join(' ') || l.address}</div></td>
                      <td className="small">
                        {l.email
                          ? <div className="stack" style={{ gap: 4, alignItems: 'flex-start' }}><span className={l.contactedBefore ? 'muted' : 'dim'}>{l.email}{l.contactedBefore ? ' (emailed before)' : ''}</span><CheckTag status={check} reason={l.checkReason} suggestion={l.suggestion} /></div>
                          : l.website ? <span className="muted">none on site</span> : <span className="muted">no website</span>}
                      </td>
                      <td className={`small num ${l.rating && l.rating < 4 ? 'warn' : 'dim'}`}>{l.rating ? `${l.rating}★ (${l.reviewCount})` : '–'}</td>
                      <td className="small">
                        {l.website && <a href={l.website} target="_blank" rel="noreferrer">Site</a>}
                        {l.phone && <div className="muted">{l.phone}</div>}
                      </td>
                      <td>{held.has(l.id) && <span className="tag">In pipeline</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {shown.length > limit && <div className="pad"><button className="btn ghost sm" onClick={() => setLimit(x => x + PAGE)}>Show {Math.min(PAGE, shown.length - limit)} more ({shown.length - limit} left)</button></div>}
          </div>
        )}
      </div>

      {sel.size > 0 && (
        <div className="bulk">
          <b>{sel.size} selected</b>
          <button className="btn sm" onClick={() => addSelected(false)}>Add to pipeline</button>
          <span className="small muted">or</span>
          <select className="select sm" value={campPick} onChange={e => setCampPick(e.target.value)} aria-label="Campaign">
            {campaigns.length ? campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>) : <option value="">No campaigns yet</option>}
          </select>
          <button className="btn primary sm" onClick={() => addSelected(true)}>Add and queue in campaign</button>
          <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}
    </div>
  )
}
