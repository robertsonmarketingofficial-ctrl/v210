import Head from 'next/head'
import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import Sky from '../components/Sky'
import { ToastHost } from '../components/ui'
import { useStore, KEYS, set, migrateLeads } from '../components/store'
import { useEngine, useEngineStatus, sendNow } from '../components/engine'
import { IconHome, IconSearch, IconBolt, IconList, IconSend, IconInbox, IconFlame, IconCog, IconPulse } from '../components/icons'
import { fmtIn } from '../components/ui'

import DashboardTab from '../components/tabs/DashboardTab'
import FinderTab from '../components/tabs/FinderTab'
import HunterTab from '../components/tabs/HunterTab'
import PipelineTab from '../components/tabs/PipelineTab'
import CampaignsTab from '../components/tabs/CampaignsTab'
import InboxTab from '../components/tabs/InboxTab'
import InboxesTab from '../components/tabs/InboxesTab'
import SettingsTab from '../components/tabs/SettingsTab'
import LiveFeed from '../components/LiveFeed'
import { useJobs, activeJobCount } from '../components/jobs'

const NAV = [
  { id: 'dashboard', label: 'Dashboard', Icon: IconHome, sub: 'Today at a glance' },
  { id: 'live', label: 'Live', Icon: IconPulse, sub: 'Every email the moment it goes out, plus today’s numbers' },
  { id: 'finder', label: 'Lead Finder', Icon: IconSearch, sub: 'Search Google Maps for businesses with an email' },
  { id: 'hunter', label: 'AFK Hunter', Icon: IconBolt, sub: 'Sweep a whole state and drop leads straight into a campaign' },
  { id: 'pipeline', label: 'Pipeline', Icon: IconList, sub: 'Every lead you’re holding' },
  { id: 'campaigns', label: 'Campaigns', Icon: IconSend, sub: 'Sequences that drip out across your inboxes' },
  { id: 'inbox', label: 'Inbox', Icon: IconInbox, sub: 'Replies from all inboxes in one place' },
  { id: 'inboxes', label: 'Inboxes & Warmup', Icon: IconFlame, sub: 'Caps, health and warmup for each Gmail' },
  { id: 'settings', label: 'Settings', Icon: IconCog, sub: 'Sending rules, backups and keys' },
]

function Clock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t) }, [])
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Adelaide', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).formatToParts(now)
  const g = (t) => parts.find(p => p.type === t)?.value || ''
  const date = now.toLocaleDateString('en-AU', { timeZone: 'Australia/Adelaide', weekday: 'long', day: 'numeric', month: 'long' })
  return (
    <div className="clock" aria-label="Adelaide time">
      <div className="clock-time">{g('hour')}:{g('minute')}<span className="sec">:{g('second')} {g('dayPeriod').toLowerCase()}</span></div>
      <div className="clock-date">{date}, Adelaide</div>
    </div>
  )
}

const hourLabel = (h) => { h = Number(h) % 24; return h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm` }

function EnginePill() {
  const st = useEngineStatus()
  const [s] = useStore(KEYS.settings)
  const [, force] = useState(0)
  useEffect(() => { const t = setInterval(() => force(x => x + 1), 1000); return () => clearInterval(t) }, [])
  const on = s.engineOn
  const live = on && st.holder && st.windowOpen
  let text = st.message
  if (on && st.holder && st.nextColdAt && st.nextColdAt > Date.now()) text = `Next email in ${fmtIn(st.nextColdAt)}`
  if (on && st.holder && !st.windowOpen) text = `Outside sending hours (${hourLabel(s.windowStart)}–${hourLabel(s.windowEnd)}${s.weekdaysOnly ? ', weekdays' : ''})`
  return (
    <div className="engine">
      <span className={`dot ${live ? 'live' : on ? 'idle' : ''}`} />
      <span className="engine-text">{on ? text : 'Sending paused'}</span>
      {on
        ? <button className="btn stop sm" onClick={() => set(KEYS.settings, x => ({ ...x, engineOn: false }))}>Pause</button>
        : <button className="btn go sm" onClick={() => { set(KEYS.settings, x => ({ ...x, engineOn: true })); setTimeout(sendNow, 50) }}>Start sending</button>}
    </div>
  )
}

function App() {
  // Remember the last tab across refreshes
  const [tab, setTabRaw] = useState('dashboard')
  useEffect(() => { try { const t = localStorage.getItem('rm_tab'); if (t && NAV.some(n => n.id === t)) setTabRaw(t) } catch {} }, [])
  const setTab = (t) => { setTabRaw(t); try { localStorage.setItem('rm_tab', t) } catch {} }
  const jobs = useJobs()
  const finderJobs = activeJobCount(jobs.filter(j => j.kind !== 'hunt'))
  const huntJobs = activeJobCount(jobs.filter(j => j.kind === 'hunt'))
  const [s] = useStore(KEYS.settings)
  const [pipeline] = useStore(KEYS.pipeline)
  const [inbox] = useStore(KEYS.inbox)
  useEngine()
  useEffect(() => { migrateLeads() }, [])

  const unread = (inbox.messages || []).filter(m => m.kind === 'reply' && !m.seen && !m.handled).length
  const current = NAV.find(n => n.id === tab)
  const props = { setTab }

  return (
    <>
      <Head><title>{unread ? `(${unread}) ` : ''}Robertson CRM</title><meta name="viewport" content="width=device-width, initial-scale=1" /></Head>
      <Sky mode={s.fx} />
      <div className="shell">
        <aside className="side">
          <div className="brand"><div className="brand-word">ROBERTSON</div><div className="brand-sub">Outreach CRM</div></div>
          <nav className="nav">
            {NAV.map(({ id, label, Icon }) => (
              <button key={id} className={`nav-item${tab === id ? ' on' : ''}`} onClick={() => setTab(id)} aria-current={tab === id ? 'page' : undefined}>
                <Icon />{label}
                {id === 'pipeline' && pipeline.length > 0 && <span className="nav-count">{pipeline.length}</span>}
                {id === 'inbox' && unread > 0 && <span className="nav-count hot">{unread}</span>}
                {id === 'finder' && finderJobs > 0 && <span className="nav-count hot" title={`${finderJobs} searches running`}>{finderJobs}</span>}
                {id === 'hunter' && huntJobs > 0 && <span className="nav-count hot" title={`${huntJobs} hunts running`}>{huntJobs}</span>}
              </button>
            ))}
          </nav>
          <div className="side-foot">Callum Robertson<br />Robertson Marketing</div>
        </aside>
        <div className="main">
          <header className="top">
            <div><div className="top-title">{current.label}</div><div className="top-sub">{current.sub}</div></div>
            <div className="top-right"><EnginePill /><Clock /></div>
          </header>
          <main className="content">
            {tab === 'dashboard' && <DashboardTab {...props} />}
            {tab === 'live' && <LiveFeed {...props} />}
            {tab === 'finder' && <FinderTab {...props} />}
            {tab === 'hunter' && <HunterTab {...props} />}
            {tab === 'pipeline' && <PipelineTab {...props} />}
            {tab === 'campaigns' && <CampaignsTab {...props} />}
            {tab === 'inbox' && <InboxTab {...props} />}
            {tab === 'inboxes' && <InboxesTab {...props} />}
            {tab === 'settings' && <SettingsTab {...props} />}
          </main>
        </div>
      </div>
      <ToastHost />
    </>
  )
}

// Everything lives in browser storage, so render client-side only.
export default dynamic(() => Promise.resolve(App), { ssr: false })
