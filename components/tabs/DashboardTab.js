import { useMemo } from 'react'
import { useStore, KEYS } from '../store'
import { accountsView, useEngineStatus } from '../engine'
import { dailySeries } from '../tracker'
import { Stat, fmtWhen, Empty } from '../ui'
import { MiniFeed } from '../LiveFeed'

export default function DashboardTab({ setTab }) {
  const [pipeline] = useStore(KEYS.pipeline)
  const [inbox] = useStore(KEYS.inbox)
  const [campaigns] = useStore(KEYS.campaigns)
  const [s] = useStore(KEYS.settings)
  const st = useEngineStatus()
  useStore(KEYS.engineLog) // re-render as the engine works

  const view = accountsView()
  const active = view.filter(a => a.status === 'active')
  const sentToday = view.reduce((n, a) => n + a.cold24, 0)
  const cap = active.reduce((n, a) => n + a.cap, 0)
  const msgs = inbox.messages || []
  const needReply = msgs.filter(m => m.kind === 'reply' && !m.handled)
  const series = dailySeries(7)
  const peak = Math.max(1, ...series.map(d => d.cold + d.warmup + d.reply))

  const funnel = useMemo(() => {
    const inSeq = pipeline.filter(l => l.seq)
    const emailed = inSeq.filter(l => (l.seq.sends || []).length)
    return [
      ['Leads held', pipeline.length],
      ['With an email', pipeline.filter(l => l.email).length],
      ['Emailed', emailed.length],
      ['Replied', pipeline.filter(l => l.lastReplyAt).length],
      ['Interested', pipeline.filter(l => ['Interested', 'Meeting booked', 'Won'].includes(l.stage)).length],
      ['Meetings', pipeline.filter(l => ['Meeting booked', 'Won'].includes(l.stage)).length],
    ]
  }, [pipeline])
  const queued = pipeline.filter(l => l.seq && ['queued', 'active'].includes(l.seq.status)).length
  const running = campaigns.filter(c => c.status === 'running').length

  const setup = [
    [view.length > 0, 'Connect your Gmail inboxes in Vercel', 'inboxes'],
    [view.some(a => a.loginOk === true), 'Test that the logins work', 'inboxes'],
    [campaigns.length > 0, 'Write a campaign', 'campaigns'],
    [pipeline.some(l => l.email), 'Find leads with emails', 'finder'],
    [active.length > 0, 'Set warmed inboxes to Active', 'inboxes'],
    [s.engineOn, 'Press Start sending (top right)', null],
  ]
  const setupLeft = setup.filter(x => !x[0])

  return (
    <div className="stack">
      {setupLeft.length > 0 && (
        <div className="panel pad">
          <div className="panel-title" style={{ marginBottom: 10 }}>Getting set up</div>
          <div className="stack" style={{ gap: 6 }}>
            {setup.map(([done, label, go]) => (
              <div key={label} className="row small">
                <span className={done ? 'ok' : 'muted'} style={{ width: 16 }}>{done ? '✓' : '○'}</span>
                <span className={done ? 'muted' : ''} style={{ textDecoration: done ? 'line-through' : 'none' }}>{label}</span>
                {!done && go && <button className="btn ghost sm" onClick={() => setTab(go)}>Go</button>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid3" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
        <Stat value={<>{sentToday}<span className="muted" style={{ fontSize: 15 }}> / {cap}</span></>} label="Cold emails, last 24h" sub={`${active.length} active inbox${active.length === 1 ? '' : 'es'}`} />
        <Stat value={needReply.length} tone={needReply.length ? 'bolt' : ''} label="Replies waiting on you" sub={needReply.length ? <button className="btn sm" style={{ marginTop: 6 }} onClick={() => setTab('inbox')}>Open inbox</button> : 'All caught up'} />
        <Stat value={funnel[5][1]} label="Meetings booked" sub={`${funnel[4][1]} interested in total`} />
        <Stat value={queued} label="Leads in a sequence" sub={`${running} campaign${running === 1 ? '' : 's'} running`} />
      </div>

      <MiniFeed onOpen={() => setTab('live')} />

      <div className="grid2" style={{ alignItems: 'start' }}>
        <div className="panel pad">
          <div className="row" style={{ marginBottom: 14 }}>
            <div className="panel-title grow">Last 7 days</div>
            <span className="small"><span className="bolt">■</span> cold <span className="warmc">■</span> warmup <span className="ok">■</span> replies</span>
          </div>
          <div className="spark">
            {series.map(d => (
              <div key={d.label} className="spark-col" title={`${d.cold} cold, ${d.warmup} warmup, ${d.reply} replies`}>
                <div className="spark-bars">
                  <span style={{ height: `${(d.cold / peak) * 100}%`, background: 'var(--bolt)' }} />
                  <span style={{ height: `${(d.warmup / peak) * 100}%`, background: 'var(--warm)', opacity: .8 }} />
                  <span style={{ height: `${(d.reply / peak) * 100}%`, background: 'var(--ok)' }} />
                </div>
                <div className="spark-l">{d.label}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel pad">
          <div className="panel-title" style={{ marginBottom: 14 }}>Funnel</div>
          {funnel.map(([label, v], i) => {
            const base = funnel[0][1] || 1
            const prev = i ? funnel[i - 1][1] : null
            return (
              <div key={label} style={{ marginBottom: 10 }}>
                <div className="row small" style={{ justifyContent: 'space-between' }}><span className="dim">{label}</span><span className="num">{v}{prev ? <span className="muted"> · {((v / prev) * 100).toFixed(prev && v / prev < 0.1 ? 1 : 0)}%</span> : ''}</span></div>
                <div className="bar"><span className="c" style={{ width: `${(v / base) * 100}%`, opacity: 1 - i * 0.1 }} /></div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="grid2" style={{ alignItems: 'start' }}>
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Latest replies</div><button className="btn ghost sm" onClick={() => setTab('inbox')}>Inbox</button></div>
          {!msgs.filter(m => m.kind === 'reply').length ? <Empty title="No replies yet" sub={st.lastSync ? `Inboxes checked ${fmtWhen(st.lastSync)}` : 'Inboxes get checked every few minutes while the CRM is open.'} /> :
            msgs.filter(m => m.kind === 'reply').slice(0, 6).map(m => {
              const l = pipeline.find(x => x.id === m.leadId)
              return (
                <div key={m.id} className="msg-item" onClick={() => setTab('inbox')}>
                  <div className="row" style={{ flexWrap: 'nowrap' }}><div className="msg-from grow" style={{ color: 'var(--text)' }}>{l?.name || m.fromEmail}</div><span className="small muted">{fmtWhen(m.date)}</span></div>
                  <div className="msg-snip">{m.text.slice(0, 140)}</div>
                </div>
              )
            })}
        </div>
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Inboxes</div><button className="btn ghost sm" onClick={() => setTab('inboxes')}>Manage</button></div>
          <div className="pad stack" style={{ gap: 12 }}>
            {!view.length && <div className="muted small">No inboxes connected yet.</div>}
            {view.map(a => (
              <div key={a.user}>
                <div className="row small" style={{ justifyContent: 'space-between' }}>
                  <span className="dim">{a.user}</span>
                  <span className={a.status === 'active' ? 'ok' : a.status === 'paused' ? 'bad' : 'warmc'}>{a.status === 'active' ? `${a.cold24}/${a.cap}` : a.status === 'warming' ? `warming, day ${a.daysWarmed}` : 'paused'}</span>
                </div>
                <div className="bar" style={{ marginTop: 5 }}>
                  <span className="c" style={{ width: `${a.status === 'active' ? Math.min(100, (a.cold24 / a.cap) * 100) : 0}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
