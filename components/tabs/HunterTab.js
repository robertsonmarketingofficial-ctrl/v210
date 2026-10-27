import { useEffect, useState } from 'react'
import { useStore, KEYS } from '../store'
import { useJobs, startHunt, stopJob, removeJob, resumeJob, splitList, REGIONS } from '../jobs'
import { Spinner, Empty, Field, toast, CATEGORIES, usePersisted } from '../ui'

const isLive = (j) => ['queued', 'running', 'checking', 'stopping'].includes(j.status)
const STATUS = { queued: 'Waiting', running: 'Hunting', checking: 'Checking', stopping: 'Stopping', done: 'Done', stopped: 'Stopped', failed: 'Failed', interrupted: 'Interrupted' }

export default function HunterTab({ setTab }) {
  const [campaigns] = useStore(KEYS.campaigns)
  const hunts = useJobs().filter(j => j.kind === 'hunt')
  const H = 'rm_hunter_form'
  const [niche, setNiche] = usePersisted(H, 'niche', 'Plumber')
  const [region, setRegion] = usePersisted(H, 'region', 'SA')
  const [goal, setGoal] = usePersisted(H, 'goal', 200)
  const [maxRating, setMaxRating] = usePersisted(H, 'maxRating', 0)
  const [campId, setCampId] = usePersisted(H, 'campId', '')
  const [open, setOpen] = useState(null)

  useEffect(() => { if ((!campId || !campaigns.some(c => c.id === campId)) && campaigns[0]) setCampId(campaigns[0].id) }, [campaigns, campId]) // eslint-disable-line
  useEffect(() => { if (!open && hunts[0]) setOpen(hunts[0].id) }, [hunts, open])

  const start = () => {
    const camp = campaigns.find(c => c.id === campId)
    if (!camp) return toast('Pick a campaign for the leads to go into')
    const trades = splitList(niche)
    if (!trades.length) return toast('Type a trade')
    let first = null
    for (const t of trades) {
      const j = startHunt({ category: t, region, campaignId: camp.id, campaignName: camp.name, goal, maxRating })
      first = first || j
    }
    setOpen(first.id)
    toast(`Started ${trades.length} hunt${trades.length === 1 ? '' : 's'}. ${trades.length > 1 ? 'Each one' : 'It'} keeps running while you use the rest of the CRM.`)
  }

  if (!campaigns.length) {
    return <div className="panel"><Empty title="Make a campaign first" sub="AFK Hunter drops every lead it finds straight into a campaign, so the sending engine can drip them out safely."><button className="btn primary" onClick={() => setTab('campaigns')}>Create a campaign</button></Empty></div>
  }

  const cur = hunts.find(h => h.id === open)

  return (
    <div className="stack">
      <div className="panel pad stack">
        <p className="small dim" style={{ margin: 0 }}>Searches suburb by suburb, checks each website for an email, removes councils, SES and government, skips anyone emailed before or whose email would bounce, and queues the rest in a campaign. It never sends directly. The engine sends them at your normal pace and limits. Runs in the background, so you can use other tabs, and you can run several hunts at once.</p>
        <div className="grid3" style={{ gridTemplateColumns: '1.4fr 1fr 1.2fr .7fr .8fr' }}>
          <Field label="Trade (comma-separated for several)"><input className="input" list="hunter-trades" value={niche} onChange={e => setNiche(e.target.value)} /><datalist id="hunter-trades">{CATEGORIES.map(c => <option key={c} value={c} />)}</datalist></Field>
          <Field label="Where"><select className="select" value={region} onChange={e => setRegion(e.target.value)}>{REGIONS.map(r => <option key={r.short} value={r.short}>{r.label}</option>)}</select></Field>
          <Field label="Into campaign"><select className="select" value={campId} onChange={e => setCampId(e.target.value)}>{campaigns.map(c => <option key={c.id} value={c.id}>{c.name}{c.status === 'running' ? '' : ' (paused)'}</option>)}</select></Field>
          <Field label="Stop after"><input className="input num" type="number" min={1} max={5000} value={goal} onChange={e => setGoal(Math.max(1, Number(e.target.value) || 1))} /></Field>
          <Field label="Rating"><select className="select" value={maxRating} onChange={e => setMaxRating(Number(e.target.value))}><option value={0}>Any</option><option value={4.5}>Below 4.5★</option><option value={4}>Below 4★</option></select></Field>
        </div>
        <div className="row"><button className="btn primary" onClick={start}>Start hunting</button><span className="small muted">Keep one CRM tab open. Closing every tab pauses hunts, and they can be resumed.</span></div>
      </div>

      {hunts.length > 0 && (
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Hunts</div></div>
          <div className="jobs">
            {hunts.map(h => (
              <div key={h.id} className={`job-row${open === h.id ? ' on' : ''}`} onClick={() => setOpen(h.id)} style={{ cursor: 'pointer' }}>
                <div className="row" style={{ flexWrap: 'nowrap', gap: 10 }}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 8 }}><b>{h.label}</b><span className={`tag ${isLive(h) ? 'bolt' : h.status === 'done' ? 'ok' : h.status === 'failed' ? 'bad' : 'warn'}`}>{isLive(h) && h.status !== 'stopping' && <Spinner size={10} />} {STATUS[h.status] || h.status}</span><span className="small muted">→ {h.campaignName}</span></div>
                    <div className="small muted" style={{ marginTop: 3 }}>{h.tally.queued}/{h.goal} queued · {h.progress.done}/{h.progress.total} suburbs{h.progress.current && isLive(h) ? ` · now: ${h.progress.current}` : ''}</div>
                    <div className="bar" style={{ marginTop: 6 }}><span className="c" style={{ width: `${Math.min(100, (h.tally.queued / h.goal) * 100)}%` }} /></div>
                  </div>
                  <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }} onClick={e => e.stopPropagation()}>
                    {isLive(h) && h.status !== 'stopping' && <button className="btn sm danger" onClick={() => stopJob(h.id)}>Stop</button>}
                    {['stopped', 'interrupted', 'failed'].includes(h.status) && h.tally.queued < h.goal && h.progress.done < h.progress.total && <button className="btn sm" onClick={() => resumeJob(h.id)}>Resume</button>}
                    <button className="btn ghost sm" aria-label="Remove" onClick={() => { removeJob(h.id); if (open === h.id) setOpen(null) }}>✕</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {cur && (
        <>
          <div className="grid3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
            {[['Suburbs searched', cur.tally.searched], ['Businesses found', cur.tally.found], ['Emails found', cur.tally.withEmail], ['Would bounce', cur.tally.invalid], ['Emailed before', cur.tally.emailedBefore], ['Councils/gov removed', cur.tally.blocked], ['Queued', cur.tally.queued]].map(([l, v]) => (
              <div key={l} className="panel stat"><div className={`stat-v ${l === 'Queued' ? 'bolt' : l === 'Would bounce' && v ? 'bad' : ''}`}>{v}</div><div className="stat-l">{l}</div></div>
            ))}
          </div>
          <div className="panel">
            <div className="panel-head"><div className="panel-title">Log: {cur.label}</div></div>
            <div className="log">
              {!cur.log?.length && <div className="muted">Nothing yet.</div>}
              {[...(cur.log || [])].reverse().map((l, i) => <div key={i} className="log-line"><span className="log-at">{new Date(l.at).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span><span className={l.type === 'sent' ? 'ok' : l.type === 'failed' ? 'bad' : l.type === 'warn' ? 'warn' : 'dim'}>{l.text}</span></div>)}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
