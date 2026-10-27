import { useState } from 'react'
import { useStore, KEYS, set, get, DEFAULT_SETTINGS } from '../store'
import { verifyLogins } from '../engine'
import { contactedCount, exportContacted, importContacted, clearContacted, exportEvents, importEvents } from '../tracker'
import { apiJSON } from '../api'
import { Field, Spinner, toast, downloadFile } from '../ui'

const hourLabel = (h) => { h = Number(h) % 24; return h === 0 ? 'midnight' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm` }
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const clamp = (v, lo, hi, float = false) => { const n = float ? Number(v) : Math.floor(Number(v)); return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo)) }

export default function SettingsTab() {
  const [s] = useStore(KEYS.settings)
  const [pipeline] = useStore(KEYS.pipeline)
  const [contacted, setContacted] = useState(contactedCount())
  const [logins, setLogins] = useState(null)
  const [checking, setChecking] = useState(false)
  const [places, setPlaces] = useState(null)
  const setS = (patch) => set(KEYS.settings, x => ({ ...x, ...patch }))

  const checkLogins = async () => { setChecking(true); setLogins(await verifyLogins()); setChecking(false) }
  const checkPlaces = async () => { setPlaces({ loading: true }); setPlaces((await apiJSON('/api/test-keys')).places || { status: 'error', error: 'No response' }) }

  const backup = () => {
    const data = {
      version: 210, at: new Date().toISOString(),
      pipeline: get(KEYS.pipeline), campaigns: get(KEYS.campaigns), settings: get(KEYS.settings),
      accounts: get(KEYS.accounts), inbox: get(KEYS.inbox), contacted: exportContacted(),
      events: exportEvents(), emailChecks: get(KEYS.verify),
    }
    downloadFile(`robertson-crm-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data))
    toast(`Backed up ${data.pipeline.length} leads and ${data.campaigns.length} campaigns`)
  }
  const restore = (e) => {
    const file = e.target.files?.[0]; if (!file) return
    const r = new FileReader()
    r.onload = () => {
      try {
        const d = JSON.parse(String(r.result))
        // Old backups were just the pipeline array
        const leads = Array.isArray(d) ? d : d.pipeline || []
        const ids = new Set(get(KEYS.pipeline).map(l => l.id))
        const added = leads.filter(l => l && l.id && !ids.has(l.id))
        set(KEYS.pipeline, list => [...list, ...added])
        if (!Array.isArray(d)) {
          if (d.campaigns) set(KEYS.campaigns, list => [...list, ...d.campaigns.filter(c => !list.some(x => x.id === c.id))])
          if (d.accounts) set(KEYS.accounts, m => ({ ...d.accounts, ...m }))
          if (d.contacted) setContacted(importContacted(d.contacted))
          if (d.events) importEvents(d.events)
          if (d.emailChecks) set(KEYS.verify, m => ({ ...d.emailChecks, ...m }))
          if (d.settings) set(KEYS.settings, x => ({ ...x, ...d.settings, engineOn: false }))
          if (d.inbox?.messages) set(KEYS.inbox, i => ({ ...i, messages: [...i.messages, ...d.inbox.messages.filter(m => !i.messages.some(x => x.id === m.id))] }))
        }
        toast(`Restored ${added.length} leads${Array.isArray(d) ? '' : ', plus campaigns and history'}`)
      } catch (err) { toast(`Restore failed: ${err.message}`) }
    }
    r.readAsText(file); e.target.value = ''
  }

  return (
    <div className="stack" style={{ maxWidth: 900 }}>
      <div className="panel pad stack">
        <div className="panel-title">When emails go out</div>
        <div className="grid3">
          <Field label="Sending starts"><select className="select" disabled={s.anyTime} value={s.windowStart} onChange={e => setS({ windowStart: Number(e.target.value) })}>{HOURS.map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}</select></Field>
          <Field label="Sending stops"><select className="select" disabled={s.anyTime} value={s.windowEnd} onChange={e => setS({ windowEnd: Number(e.target.value) })}>{HOURS.map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}</select></Field>
          <Field label="Your name on emails"><input className="input" value={s.fromName} onChange={e => setS({ fromName: e.target.value })} /></Field>
        </div>
        <label className="row small dim" style={{ gap: 8 }}><input type="checkbox" checked={!!s.anyTime} onChange={e => setS({ anyTime: e.target.checked })} /> Send at any hour (ignore the sending window)</label>
        {s.anyTime && <div className="small warn">Emails landing at 2am look automated and get buried by morning. Business hours usually get more replies.</div>}
        <label className="row small dim" style={{ gap: 8 }}><input type="checkbox" checked={s.weekdaysOnly} onChange={e => setS({ weekdaysOnly: e.target.checked })} /> Weekdays only</label>
        <label className="row small dim" style={{ gap: 8 }}><input type="checkbox" checked={s.leadLocalTime} onChange={e => setS({ leadLocalTime: e.target.checked })} /> Use the lead’s local time (a Perth lead gets emailed during Perth hours)</label>
      </div>

      <div className="panel pad stack">
        <div className="panel-title">How fast</div>
        <div className="grid3">
          <Field label="Default emails per inbox per day" hint="For inboxes without their own limit. Set each inbox’s limit when you start a campaign or on Inboxes & Warmup."><input className="input num" type="number" min={1} max={150} value={s.perInboxCap} onChange={e => setS({ perInboxCap: clamp(e.target.value, 1, 150) })} /></Field>
          <Field label="Pacing">
            <div className="seg">{[['spread', 'Spread across the day'], ['fixed', 'Fixed gap']].map(([k, l]) => <button key={k} className={s.pacing === k ? 'on' : ''} onClick={() => setS({ pacing: k })}>{l}</button>)}</div>
          </Field>
          <div />
          <Field label={s.pacing === 'spread' ? 'Never faster than (seconds)' : 'Shortest gap (seconds)'}><input className="input num" type="number" min={1} value={s.minGapSec} onChange={e => setS({ minGapSec: clamp(e.target.value, 1, 3600) })} /></Field>
          <Field label={s.pacing === 'spread' ? 'Gap when nothing’s left today (seconds)' : 'Longest gap (seconds)'}><input className="input num" type="number" min={1} value={s.maxGapSec} onChange={e => setS({ maxGapSec: Math.max(s.minGapSec, clamp(e.target.value, 1, 7200)) })} /></Field>
        </div>
        <div className="small muted">
          {s.pacing === 'spread'
            ? 'Spread works out what’s left of today’s limit and what’s left of the sending window, then spaces emails evenly with some randomness. 200 emails over 9 hours goes out roughly one every 2–3 minutes, which looks like a person, not a script.'
            : `Each email waits a random ${s.minGapSec}–${s.maxGapSec} seconds.`}
          {s.pacing === 'fixed' && s.maxGapSec < 60 && <span className="warn"> Short gaps mean bursts of sends, which Gmail watches for.</span>}
        </div>
      </div>

      <div className="panel pad stack">
        <div className="panel-title">Bounce protection</div>
        <label className="row small dim" style={{ gap: 8 }}><input type="checkbox" checked={s.verifyBeforeSend} onChange={e => setS({ verifyBeforeSend: e.target.checked })} /> Check every address before its first email, and skip any that would bounce</label>
        <label className="row small dim" style={{ gap: 8, marginLeft: 24 }}><input type="checkbox" disabled={!s.verifyBeforeSend} checked={s.sendIfUncheckable} onChange={e => setS({ sendIfUncheckable: e.target.checked })} /> If the check can’t run (network hiccup), send anyway instead of waiting an hour</label>
        <label className="row small dim" style={{ gap: 8 }}><input type="checkbox" checked={s.autoCheckFound} onChange={e => setS({ autoCheckFound: e.target.checked })} /> Bounce-check emails as soon as Lead Finder finds them</label>
        <label className="row small dim" style={{ gap: 8 }}><input type="checkbox" checked={s.autoPause} onChange={e => setS({ autoPause: e.target.checked })} /> Pause an inbox automatically if its bounce rate gets too high</label>
        <div className="grid3">
          <Field label="Pause above this bounce rate (%)"><input className="input num" type="number" min={1} max={50} step={0.5} disabled={!s.autoPause} value={s.bouncePausePct} onChange={e => setS({ bouncePausePct: clamp(e.target.value, 1, 50, true) })} /></Field>
          <Field label="Only after this many sends (7 days)"><input className="input num" type="number" min={1} max={500} disabled={!s.autoPause} value={s.bouncePauseMin} onChange={e => setS({ bouncePauseMin: clamp(e.target.value, 1, 500) })} /></Field>
          <div />
          <Field label="Retry a failed send up to (times)"><input className="input num" type="number" min={1} max={10} value={s.maxAttempts} onChange={e => setS({ maxAttempts: clamp(e.target.value, 1, 10) })} /></Field>
          <Field label="Wait between retries (minutes)"><input className="input num" type="number" min={1} max={1440} value={s.retryMins} onChange={e => setS({ retryMins: clamp(e.target.value, 1, 1440) })} /></Field>
        </div>
        <div className="small muted">The check confirms the address is real and its domain has a working mail server (expired websites and typos are where most bounces come from). It can’t confirm the exact mailbox exists, so a few bounces can still happen. Those are caught from your inbox.</div>
      </div>

      <div className="panel pad stack">
        <div className="panel-title">Who never gets emailed</div>
        <label className="row small dim" style={{ gap: 8 }}><input type="checkbox" checked={s.blockBuiltIn} onChange={e => setS({ blockBuiltIn: e.target.checked })} /> Block emergency services (SES, CFS, MFS, police), councils, government, schools, hospitals, churches, clubs, charities and utilities</label>
        <Field label="Never email these too" hint="Business names, words, email addresses or domains, separated by commas or new lines (e.g. bunnings, kennards, @competitor.com.au)."><textarea className="input" rows={3} value={s.blockList || ''} onChange={e => setS({ blockList: e.target.value })} placeholder="bunnings, kennards, stratco, @competitor.com.au" /></Field>
      </div>

      <div className="panel pad stack">
        <div className="panel-title">Warmup</div>
        <label className="row small dim" style={{ gap: 8 }}><input type="checkbox" checked={s.warmupEnabled} onChange={e => setS({ warmupEnabled: e.target.checked })} /> Send warmup emails between my own inboxes</label>
        <div className="grid3">
          <Field label="Day 1 warmup emails per inbox"><input className="input num" type="number" min={1} max={50} value={s.warmupStart} onChange={e => setS({ warmupStart: clamp(e.target.value, 1, 50) })} /></Field>
          <Field label="Add this many each day"><input className="input num" type="number" min={0} max={20} value={s.warmupStep} onChange={e => setS({ warmupStep: clamp(e.target.value, 0, 20) })} /></Field>
          <Field label="Up to a max of"><input className="input num" type="number" min={1} max={100} value={s.warmupMax} onChange={e => setS({ warmupMax: clamp(e.target.value, 1, 100) })} /></Field>
          <Field label="Warmup from"><select className="select" value={s.warmupHourStart} onChange={e => setS({ warmupHourStart: Number(e.target.value) })}>{HOURS.map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}</select></Field>
          <Field label="Warmup until"><select className="select" value={s.warmupHourEnd} onChange={e => setS({ warmupHourEnd: Number(e.target.value) })}>{HOURS.map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}</select></Field>
          <Field label="Minutes between warmup emails"><div className="row" style={{ flexWrap: 'nowrap' }}><input className="input num" type="number" min={1} max={120} value={s.warmupGapMin} onChange={e => setS({ warmupGapMin: clamp(e.target.value, 1, 120) })} /><span className="muted">to</span><input className="input num" type="number" min={1} max={240} value={s.warmupGapMax} onChange={e => setS({ warmupGapMax: Math.max(s.warmupGapMin, clamp(e.target.value, 1, 240)) })} /></div></Field>
        </div>
      </div>

      <div className="panel pad stack">
        <div className="panel-title">Replies</div>
        <Field label="Check inboxes for replies every"><select className="select" style={{ maxWidth: 200 }} value={s.inboxSyncMins} onChange={e => setS({ inboxSyncMins: Number(e.target.value) })}>{[2, 5, 10, 15, 30].map(m => <option key={m} value={m}>{m} minutes</option>)}</select></Field>
        <label className="row small dim" style={{ gap: 8 }}><input type="checkbox" checked={!!s.stopOnAutoReply} onChange={e => setS({ stopOnAutoReply: e.target.checked })} /> Stop the sequence when someone’s auto-reply (out of office) comes back</label>
        <div className="small muted">A real reply always stops the sequence.</div>
      </div>

      <div className="panel pad stack">
        <div className="panel-title">Lead search</div>
        <div className="grid3">
          <Field label="Results per suburb"><select className="select" value={s.searchPages} onChange={e => setS({ searchPages: Number(e.target.value) })}><option value={1}>Up to 20</option><option value={2}>Up to 40</option><option value={3}>Up to 60</option></select></Field>
          <Field label="Google searches at once" hint="Across every search and hunt running."><input className="input num" type="number" min={1} max={5} value={s.searchConcurrency} onChange={e => setS({ searchConcurrency: clamp(e.target.value, 1, 5) })} /></Field>
          <Field label="Websites checked at once"><input className="input num" type="number" min={1} max={12} value={s.scrapeConcurrency} onChange={e => setS({ scrapeConcurrency: clamp(e.target.value, 1, 12) })} /></Field>
        </div>
        <div className="small muted">Each Google search page costs Places API credit. Up to 60 results per suburb uses 3 calls.</div>
        <div><button className="btn ghost sm" onClick={() => { if (confirm('Reset all sending, bounce, warmup and search settings to defaults? Your name, blocklist and background stay.')) set(KEYS.settings, x => ({ ...DEFAULT_SETTINGS, engineOn: x.engineOn, fx: x.fx, fromName: x.fromName, blockList: x.blockList })) }}>Reset all settings to defaults</button></div>
      </div>

      <div className="panel pad stack">
        <div className="panel-title">Background</div>
        <div className="seg">{[['storm', 'Thunderstorm'], ['stars', 'Shooting stars'], ['off', 'Plain black']].map(([k, l]) => <button key={k} className={s.fx === k ? 'on' : ''} onClick={() => setS({ fx: k })}>{l}</button>)}</div>
      </div>

      <div className="panel pad stack">
        <div className="row"><div className="panel-title grow">Gmail connection</div><button className="btn sm" disabled={checking} onClick={checkLogins}>{checking ? <Spinner size={12} /> : 'Test logins'}</button></div>
        <div className="small dim">Inboxes come from two Vercel environment variables, comma-separated and in the same order: <b>GMAIL_USERS</b> and <b>GMAIL_APP_PASSWORDS</b>. Each Gmail needs 2-Step Verification on and a 16-letter App Password from myaccount.google.com/apppasswords. Redeploy after changing them. The same App Password is used to read replies over IMAP.</div>
        {logins && (logins.accountCount ? logins.accounts.map((a, i) => (
          <div key={a.user} className="row small"><span className={`tag ${a.ok ? 'ok' : 'bad'}`}>{a.ok ? 'Login OK' : 'Failed'}</span><b>{a.user}</b>{!a.ok && <span className="muted" style={{ flexBasis: '100%' }}>{a.error}</span>}{logins.passwordLengths?.[i] !== 16 && <span className="warn">Password is {logins.passwordLengths[i]} characters, App Passwords are 16.</span>}</div>
        )) : <div className="small bad">{logins.error || 'No Gmail inboxes are configured on the server.'}</div>)}
      </div>

      <div className="panel pad stack">
        <div className="row"><div className="panel-title grow">Google Places key</div><button className="btn sm" onClick={checkPlaces}>{places?.loading ? <Spinner size={12} /> : 'Test key'}</button></div>
        <div className="small dim">Used by Lead Finder and AFK Hunter. Set <b>GOOGLE_PLACES_API_KEY</b> in Vercel.</div>
        {places && !places.loading && <div className={`small ${places.status === 'working' ? 'ok' : 'bad'}`}>{places.status === 'working' ? 'Working' : places.error}</div>}
      </div>

      <div className="panel pad stack">
        <div className="panel-title">Backup</div>
        <div className="small dim">Everything lives in this browser only: {pipeline.length} leads, your campaigns, inbox history and the list of {contacted} addresses you’ve ever emailed. Clearing your browser or switching computers loses it unless you back up. One file covers all of it, and old pipeline backups still restore.</div>
        <div className="row">
          <button className="btn primary sm" onClick={backup}>Download backup</button>
          <label className="btn sm" style={{ cursor: 'pointer' }}>Restore from file<input type="file" accept=".json" onChange={restore} style={{ display: 'none' }} /></label>
        </div>
        <hr className="sep" />
        <div className="small dim">The emailed-before list stops anyone getting a first cold email twice, across every campaign and sweep.</div>
        <div><button className="btn danger sm" onClick={() => { if (confirm(`Forget all ${contacted} emailed-before addresses? The same businesses could then get cold emailed again.`)) { clearContacted(); setContacted(0); toast('Cleared') } }}>Clear emailed-before list</button></div>
      </div>
    </div>
  )
}
