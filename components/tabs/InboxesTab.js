import { useState } from 'react'
import { useStore, KEYS, set } from '../store'
import { accountsView, setAccountMeta, verifyLogins, loadServerAccounts, useEngineStatus, setInboxCap, MAX_INBOX_CAP } from '../engine'
import { nextFreeAt } from '../tracker'
import { Empty, Spinner, toast, fmtWhen, Field } from '../ui'

const STATUS = {
  warming: { label: 'Warming', tone: 'warm', help: 'Warmup only. No cold emails.' },
  active: { label: 'Active', tone: 'ok', help: 'Cold emails plus warmup.' },
  paused: { label: 'Paused', tone: 'bad', help: 'Sends nothing.' },
}

function Meter({ value, max, cls }) {
  const w = max ? Math.min(100, (value / max) * 100) : 0
  return <div className="bar"><span className={cls} style={{ width: `${w}%` }} /></div>
}

export default function InboxesTab() {
  const [s] = useStore(KEYS.settings)
  const [log] = useStore(KEYS.engineLog)
  useStore(KEYS.accounts)
  const st = useEngineStatus()
  const [checking, setChecking] = useState(false)
  const view = accountsView()

  const setS = (patch) => set(KEYS.settings, x => ({ ...x, ...patch }))
  const check = async () => {
    setChecking(true)
    await loadServerAccounts()
    const d = await verifyLogins()
    setChecking(false)
    toast(d.accountCount ? `${d.okCount} of ${d.accountCount} inboxes logged in` : 'No inboxes configured on the server')
  }
  const setStatus = (a, status) => {
    const patch = { status, pausedReason: null, pausedUntil: null }
    if (status === 'warming' && !a.meta.warmupSince) patch.warmupSince = new Date().toISOString()
    setAccountMeta(a.user, patch)
  }
  const totals = view.reduce((t, a) => ({ cold: t.cold + a.cold24, cap: t.cap + (a.status === 'active' ? a.cap : 0), warm: t.warm + a.warm24 }), { cold: 0, cap: 0, warm: 0 })

  return (
    <div className="stack">
      <div className="row">
        <div className="grow dim small">
          Today: <b style={{ color: 'var(--text)' }}>{totals.cold}</b> of {totals.cap} cold emails sent, <b className="warmc">{totals.warm}</b> warmup emails. Counts are rolling 24 hours, the same way Gmail counts.
        </div>
        <button className="btn" disabled={checking} onClick={check}>{checking ? <><Spinner size={12} /> Checking</> : 'Test logins'}</button>
      </div>

      {st.serverLoaded && !view.length && (
        <div className="panel"><Empty title="No Gmail inboxes connected" sub="Add GMAIL_USERS and GMAIL_APP_PASSWORDS in Vercel (comma-separated, same order), then redeploy." /></div>
      )}

      <div className="panel">
        {view.length > 0 && (
          <div className="table-wrap" style={{ maxHeight: 'none' }}>
            <table className="table">
              <thead><tr><th>Inbox</th><th>Mode</th><th style={{ width: 170 }}>Cold today</th><th style={{ width: 170 }}>Warmup today</th><th>Bounces (7d)</th><th>Replies (7d)</th><th>Warmup health</th></tr></thead>
              <tbody>
                {view.map(a => {
                  const free = a.status === 'active' && a.remaining === 0 ? nextFreeAt(a.user) : null
                  const wp = a.meta.lastWarmupProcess
                  return (
                    <tr key={a.user}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{a.user}</div>
                        <div className="small">
                          {a.loginOk === true && <span className="ok">Login OK</span>}
                          {a.loginOk === false && <span className="bad" title={a.meta.lastVerify?.error}>Login failed</span>}
                          {a.loginOk === null && <span className="muted">Login not tested</span>}
                          <span className="muted"> · warming {a.daysWarmed} day{a.daysWarmed === 1 ? '' : 's'}</span>
                        </div>
                        {a.status === 'paused' && a.meta.pausedReason && <div className="small bad" style={{ maxWidth: 260 }}>{a.meta.pausedReason}</div>}
                      </td>
                      <td>
                        <select className="select sm" value={a.status} onChange={e => setStatus(a, e.target.value)} aria-label={`Mode for ${a.user}`}>
                          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                        </select>
                        <div className="small muted" style={{ marginTop: 4 }}>{STATUS[a.status]?.help}</div>
                      </td>
                      <td>
                        <div className="row small num" style={{ justifyContent: 'space-between' }}>
                          <span>{a.cold24}</span>
                          {a.status === 'active'
                            ? <span className="muted row" style={{ gap: 4 }}>/ <input className="input sm num" type="number" min={0} max={MAX_INBOX_CAP} value={a.cap} style={{ width: 64 }} aria-label={`Daily limit for ${a.user}`} onChange={e => setInboxCap(a.user, e.target.value)} /></span>
                            : <span className="muted">/ 0</span>}
                        </div>
                        <Meter value={a.cold24} max={a.status === 'active' ? a.cap : 1} cls="c" />
                        {free && <div className="small muted" style={{ marginTop: 4 }}>Full. Frees up {free.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}</div>}
                      </td>
                      <td>
                        <div className="row small num" style={{ justifyContent: 'space-between' }}><span className="warmc">{a.warm24}</span><span className="muted">/ {s.warmupEnabled ? a.warmTarget : 0}</span></div>
                        <Meter value={a.warm24} max={a.warmTarget} cls="w" />
                      </td>
                      <td className={`num ${a.bounceRate > 0.03 ? 'bad' : 'dim'}`}>{a.bounce7} {a.cold7 ? `(${(a.bounceRate * 100).toFixed(1)}%)` : ''}</td>
                      <td className="num dim">{a.replies7}</td>
                      <td className="small">
                        {wp ? <>
                          <div className={wp.rescued ? 'warn' : 'ok'}>{wp.rescued ? `${wp.rescued} pulled out of spam` : 'Nothing in spam'}</div>
                          <div className="muted">checked {fmtWhen(wp.at)}</div>
                        </> : <span className="muted">Not checked yet</span>}
                        {a.status === 'warming' && a.daysWarmed >= 14 && <div className="ok">Ready to go Active</div>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid2">
        <div className="panel pad stack">
          <div className="row"><div className="panel-title grow">Warmup</div>
            <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={s.warmupEnabled} onChange={e => setS({ warmupEnabled: e.target.checked })} /> On</label>
          </div>
          <p className="small dim" style={{ margin: 0 }}>
            Your inboxes email each other, then open, star, mark important and reply to those emails, and pull any out of spam. That tells Gmail these are real, wanted conversations.
            Each inbox starts at {s.warmupStart} a day and adds {s.warmupStep} a day up to {s.warmupMax}. Runs 7am to 9pm Adelaide time, every day, while the CRM is open.
          </p>
          <div className="grid3">
            <Field label="Start per day"><input className="input num" type="number" min={1} max={20} value={s.warmupStart} onChange={e => setS({ warmupStart: Number(e.target.value) || 1 })} /></Field>
            <Field label="Add per day"><input className="input num" type="number" min={0} max={10} value={s.warmupStep} onChange={e => setS({ warmupStep: Number(e.target.value) || 0 })} /></Field>
            <Field label="Max per day"><input className="input num" type="number" min={1} max={40} value={s.warmupMax} onChange={e => setS({ warmupMax: Number(e.target.value) || 1 })} /></Field>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            With only {view.length || 6} inboxes this is a small, closed warmup loop. It helps, but a paid warmup network (Instantly, Lemwarm) talks to thousands of real inboxes and builds reputation faster. Leave this running either way.
          </p>
        </div>
        <div className="panel pad stack">
          <div className="panel-title">How to use this</div>
          <ol className="small dim" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
            <li>New inboxes start in <span className="warmc">Warming</span>. Leave them there for 2 to 3 weeks.</li>
            <li>Switch each to <span className="ok">Active</span> once it shows “Ready to go Active” and nothing is landing in spam.</li>
            <li>Active inboxes send up to their own daily limit (the number next to Cold today) and keep warming. Inboxes without one use {s.perInboxCap} from Settings.</li>
            <li>An inbox auto-pauses if its login fails, Gmail rate-limits it, or bounces go over 5% for the week.</li>
          </ol>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><div className="panel-title">Engine log</div><button className="btn ghost sm" onClick={() => set(KEYS.engineLog, [])}>Clear</button></div>
        <div className="log">
          {!log.length && <div className="muted">Sends, replies, pauses and errors show up here.</div>}
          {[...log].reverse().map((l, i) => (
            <div key={i} className="log-line"><span className="log-at">{new Date(l.at).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}</span><span className={l.type === 'sent' ? 'ok' : l.type === 'failed' ? 'bad' : l.type === 'warn' ? 'warn' : 'dim'}>{l.text}</span></div>
          ))}
        </div>
      </div>
    </div>
  )
}
