// THE SEND ENGINE — runs in the browser while the CRM tab is open.
//
// Every few seconds it:
//   1. sends the next due campaign email (one at a time, random gap from Settings,
//      rotating across inboxes, each inbox capped at N cold emails per 24h,
//      only inside business hours where the lead is)
//   2. sends warmup emails between your own inboxes, ramping up daily
//   3. tidies warmup mail on each inbox (out of spam, opened, starred, replied)
//   4. syncs every inbox for replies and bounces, and stops sequences for
//      anyone who replied or bounced
//
// Only ONE tab runs the engine (a lock in localStorage). Close every tab and
// it all pauses; open the CRM again and it picks up where it left off.

import { useEffect, useState } from 'react'
import { apiJSON } from './api'
import { KEYS, get, set, patchLead, STAGES, settings as getSettings, updateLeads } from './store'
import { render, inWindow, inWindowTz, windowMsLeft, leadSuburb, leadState } from './templating'
import { checkEmail, cachedCheck } from './verifyClient'
import { blockReason, parseExtra } from './blocklist'
import { recordEvent, count24h, stats, hasBeenContacted, markContacted } from './tracker'

const DAY = 86400000
const TICK_MS = 1000
const LOCK_KEY = 'rm_engine_lock'
const LOCK_STALE = 45000
const tabId = Math.random().toString(36).slice(2)
const lower = (s) => String(s || '').trim().toLowerCase()
const rand = (a, b) => a + Math.random() * (b - a)

// ── Status shared with the UI ─────────────────────────────────
let status = {
  holder: false, sending: false, syncing: false,
  nextColdAt: 0, nextWarmAt: 0, lastSync: 0,
  message: 'Starting…', windowOpen: false,
  serverAccounts: [], serverLoaded: false,
}
const listeners = new Set()
function setStatus(p) { status = { ...status, ...p }; listeners.forEach(fn => fn(status)) }
export function useEngineStatus() {
  const [s, setS] = useState(status)
  useEffect(() => { listeners.add(setS); return () => listeners.delete(setS) }, [])
  return s
}

export function log(text, type = 'info') {
  set(KEYS.engineLog, l => [...(l || []).slice(-199), { at: Date.now(), type, text }])
}

// ── Live feed ─────────────────────────────────────────────────
// Structured record of every send, reply, bounce and problem, for the Live
// tab. Kept separate from the plain-text log. Last 500 events.
export const SESSION_START = Date.now()
export function feed(entry) {
  set(KEYS.feed, l => [...(l || []).slice(-499), { id: Math.random().toString(36).slice(2), at: Date.now(), ...entry }])
}
const leadInfo = (lead) => lead ? {
  name: lead.name, email: lead.email, category: lead.category || '',
  suburb: leadSuburb(lead) || '', state: leadState(lead) || '', leadId: lead.id,
} : {}

// ── Inboxes ───────────────────────────────────────────────────
export function setAccountMeta(user, patch) {
  set(KEYS.accounts, m => ({ ...m, [lower(user)]: { ...(m?.[lower(user)] || {}), ...patch } }))
}

export function warmupTarget(meta, s) {
  if (!meta?.warmupSince) return s.warmupStart
  const days = Math.max(0, Math.floor((Date.now() - new Date(meta.warmupSince).getTime()) / DAY))
  return Math.min(s.warmupMax, s.warmupStart + s.warmupStep * days)
}

export const MAX_INBOX_CAP = 150

export function inboxCap(meta, s = getSettings()) {
  const c = Number(meta?.cap)
  return Number.isFinite(c) && c >= 0 ? Math.min(MAX_INBOX_CAP, Math.floor(c)) : s.perInboxCap
}

export function setInboxCap(user, cap) {
  const n = Math.min(MAX_INBOX_CAP, Math.max(0, Math.floor(Number(cap) || 0)))
  setAccountMeta(user, { cap: n })
  return n
}

// Total cold emails per 24h across every Active inbox, using each inbox's own cap.
export function activeCapacity(view = accountsView()) {
  return view.filter(a => a.status === 'active').reduce((n, a) => n + a.cap, 0)
}

export function accountsView() {
  const s = getSettings()
  const meta = get(KEYS.accounts) || {}
  return status.serverAccounts.map(user => {
    const m = meta[lower(user)] || {}
    const st = stats(user)
    let state = m.status || 'warming'
    // Auto-resume a quota pause once 24h has passed
    if (state === 'paused' && m.pausedUntil && Date.now() > m.pausedUntil) state = m.prevStatus || 'active'
    const daysWarmed = m.warmupSince ? Math.floor((Date.now() - new Date(m.warmupSince).getTime()) / DAY) : 0
    // Each inbox can have its own daily cap (set when starting a campaign or on
    // the Inboxes tab). Inboxes without one use the default from Settings.
    const cap = inboxCap(m, s)
    return {
      user, status: state, meta: m, ...st,
      cap,
      remaining: state === 'active' ? Math.max(0, cap - st.cold24) : 0,
      warmTarget: warmupTarget(m, s),
      daysWarmed,
      loginOk: m.lastVerify ? m.lastVerify.ok : null,
    }
  })
}

export async function loadServerAccounts() {
  const d = await apiJSON('/api/accounts', { timeoutMs: 20000 })
  const list = Array.isArray(d.accounts) ? d.accounts : []
  // New inboxes start in warmup so they never cold-send on day one
  const meta = get(KEYS.accounts) || {}
  for (const u of list) {
    if (!meta[lower(u)]) setAccountMeta(u, { status: 'warming', warmupSince: new Date().toISOString() })
  }
  setStatus({ serverAccounts: list, serverLoaded: true, serverError: d.error && !d.accounts ? d.error : null })
  return list
}

export async function verifyLogins() {
  const d = await apiJSON('/api/accounts', { method: 'POST', timeoutMs: 40000 })
  for (const a of d.accounts || []) setAccountMeta(a.user, { lastVerify: { ok: a.ok, error: a.error || null, at: Date.now() } })
  return d
}

function pauseAccount(user, reason, hours = null) {
  const m = (get(KEYS.accounts) || {})[lower(user)] || {}
  setAccountMeta(user, {
    status: 'paused', pausedReason: reason,
    prevStatus: m.status === 'paused' ? m.prevStatus : (m.status || 'active'),
    pausedUntil: hours ? Date.now() + hours * 3600000 : null,
  })
  log(`Paused ${user}: ${reason}`, 'warn')
  feed({ type: 'paused', from: user, error: reason })
}

// ── Campaign sending ──────────────────────────────────────────
function pickAccount(view, preferred) {
  const ok = view.filter(a => a.status === 'active' && a.remaining > 0 && a.loginOk !== false)
  // Follow-ups go from the same inbox so they thread. If that inbox has been
  // removed from Vercel altogether, fall back to any inbox instead of the
  // follow-up waiting forever.
  if (preferred && view.some(a => lower(a.user) === lower(preferred))) return ok.find(a => lower(a.user) === lower(preferred)) || null
  if (!ok.length) return null
  // Least-used inbox first, so the load spreads evenly through the day
  return ok.sort((a, b) => a.cold24 - b.cold24)[0]
}

function dueLeads(now) {
  const s = getSettings()
  const camps = new Map((get(KEYS.campaigns) || []).filter(c => c.status === 'running').map(c => [c.id, c]))
  return (get(KEYS.pipeline) || [])
    .filter(l => l.seq && ['queued', 'active'].includes(l.seq.status) && camps.has(l.seq.campaignId) &&
      (l.seq.nextAt || 0) <= now && l.email && !l.bounced && inWindow(s, l, new Date(now)))
    .sort((a, b) => (b.seq.step > 0) - (a.seq.step > 0) || (a.seq.nextAt || 0) - (b.seq.nextAt || 0))
    .map(l => ({ lead: l, camp: camps.get(l.seq.campaignId) }))
}

// For the Live tab: how many emails are due right now / waiting later.
export function queueInfo() {
  const now = Date.now()
  const camps = new Set((get(KEYS.campaigns) || []).filter(c => c.status === 'running').map(c => c.id))
  let dueNow = 0, waiting = 0, followUpsDue = 0
  for (const l of get(KEYS.pipeline) || []) {
    if (!l.seq || !['queued', 'active'].includes(l.seq.status) || !camps.has(l.seq.campaignId) || !l.email || l.bounced) continue
    waiting++
    if ((l.seq.nextAt || 0) <= now) { dueNow++; if ((l.seq.step || 0) > 0) followUpsDue++ }
  }
  return { dueNow, waiting, followUpsDue }
}

function bumpStage(stage, to) {
  return STAGES.indexOf(stage) < STAGES.indexOf(to) ? to : stage
}

async function sendNextCold() {
  const s = getSettings()
  const now = Date.now()
  const view = accountsView()
  const due = dueLeads(now)
  if (!due.length) return { idle: true, why: 'Nothing due right now' }
  if (!view.some(a => a.status === 'active')) return { idle: true, why: 'No inbox is set to Active yet (Inboxes tab)' }

  let pick = null
  for (const d of due) {
    const acc = pickAccount(view, d.lead.seq.step > 0 ? d.lead.seq.account : null)
    if (acc) { pick = { ...d, acc }; break }
  }
  if (!pick) return { idle: true, why: 'Every active inbox has hit today’s cap' }

  const { lead, camp, acc } = pick
  const stepIdx = lead.seq.step || 0
  const step = camp.steps[stepIdx]
  if (!step) {
    patchLead(lead.id, l => ({ seq: { ...l.seq, status: 'done' } }))
    return { idle: false }
  }

  // Never email emergency services, councils, government, schools, etc., or
  // anything on the Never email list in Settings. Checked on every step, so
  // leads that were already queued are caught too.
  const blocked = blockReason(lead, parseExtra(s.blockList), { builtIn: s.blockBuiltIn !== false })
  if (blocked) {
    patchLead(lead.id, l => ({ blocked, seq: { ...l.seq, status: 'stopped', error: `Not a business to email (${blocked})` } }))
    log(`Blocked ${lead.name} <${lead.email}>: ${blocked}`, 'warn')
    feed({ type: 'skipped', ...leadInfo(lead), campaign: camp.name, error: `Blocked, not a business to email (${blocked})` })
    return { idle: false }
  }

  // Never send a FIRST email to an address that's been emailed before
  if (stepIdx === 0 && !(lead.seq.sends || []).length && hasBeenContacted(lead.email)) {
    patchLead(lead.id, l => ({ seq: { ...l.seq, status: 'stopped', error: 'Already emailed in an earlier run' } }))
    log(`Skipped ${lead.name}: ${lead.email} was emailed before`, 'warn')
    feed({ type: 'skipped', ...leadInfo(lead), campaign: camp.name, error: 'Already emailed in an earlier run' })
    return { idle: false }
  }

  // Bounce check before the FIRST email: does this address's domain actually
  // accept mail? Dead addresses are skipped here and never count as a bounce
  // against your inbox.
  if (stepIdx === 0 && s.verifyBeforeSend) {
    let check = cachedCheck(lead.email)
    if (!check) {
      setStatus({ message: `Checking ${lead.email} won’t bounce…` })
      check = await checkEmail(lead.email)
    }
    if (check.status === 'invalid') {
      patchLead(lead.id, l => ({ emailCheck: { email: lower(lead.email), status: 'invalid', reason: check.reason, suggestion: check.suggestion || null, at: Date.now() }, seq: { ...l.seq, status: 'stopped', error: `Would bounce: ${check.reason}` } }))
      log(`Skipped ${lead.name} <${lead.email}>: would bounce (${check.reason})`, 'warn')
      feed({ type: 'invalid', ...leadInfo(lead), campaign: camp.name, error: `${check.reason}${check.suggestion ? `. Did you mean ${check.suggestion}?` : ''}` })
      return { idle: false }
    }
    if (check.status === 'unknown' && !s.sendIfUncheckable) {
      patchLead(lead.id, l => ({ seq: { ...l.seq, nextAt: Date.now() + 60 * 60000, error: `Couldn’t check the address yet (${check.reason}). Trying again in an hour.` } }))
      return { idle: false }
    }
    if (lead.emailCheck?.status !== check.status) patchLead(lead.id, { emailCheck: { email: lower(lead.email), status: check.status, reason: check.reason, at: Date.now() } })
  }

  const ctx = { fromName: s.fromName }
  const isFollow = stepIdx > 0
  const subject = isFollow && !String(step.subject || '').trim()
    ? (/^re:/i.test(lead.seq.subject || '') ? lead.seq.subject : `Re: ${lead.seq.subject || ''}`)
    : render(step.subject, lead, ctx)
  const text = render(step.body, lead, ctx)

  setStatus({ sending: true, message: `Sending to ${lead.email}…`, current: { to: lead.email, name: lead.name, from: acc.user, step: stepIdx + 1, steps: camp.steps.length, campaign: camp.name, startedAt: Date.now() } })
  const sendStarted = Date.now()
  const r = await apiJSON('/api/send', {
    method: 'POST',
    body: {
      from: acc.user, to: lead.email, subject, text, fromName: s.fromName,
      inReplyTo: isFollow ? lead.seq.lastMessageId : undefined,
      references: isFollow ? lead.seq.refs : undefined,
    },
  })
  setStatus({ sending: false, current: null })
  const tookMs = Date.now() - sendStarted
  const base = { ...leadInfo(lead), from: acc.user, step: stepIdx + 1, steps: camp.steps.length, campaign: camp.name, campaignId: camp.id, subject, ms: tookMs }

  if (r.success) {
    feed({ type: 'sent', ...base, followUp: isFollow })
    recordEvent(acc.user, 'cold', { leadId: lead.id })
    markContacted(lead.email)
    const nextStep = stepIdx + 1
    const more = nextStep < camp.steps.length
    patchLead(lead.id, l => ({
      contacted: true,
      stage: bumpStage(l.stage, 'Contacted'),
      seq: {
        ...l.seq,
        status: more ? 'active' : 'done',
        step: nextStep,
        account: l.seq.account || acc.user,
        subject: stepIdx === 0 ? subject : l.seq.subject,
        lastMessageId: r.messageId,
        refs: [...(l.seq.refs || []), r.messageId].filter(Boolean).slice(-10),
        nextAt: more ? Date.now() + Number(camp.steps[nextStep].delayDays || 3) * DAY : null,
        sends: [...(l.seq.sends || []), { step: stepIdx, at: Date.now(), account: acc.user, messageId: r.messageId, subject, text }],
        attempts: 0, error: null,
      },
    }))
    log(`Sent step ${stepIdx + 1} to ${lead.name} from ${acc.user}`, 'sent')
    return { idle: false }
  }

  // Failure handling
  if (r.kind === 'recipient') {
    patchLead(lead.id, l => ({ bounced: true, seq: { ...l.seq, status: 'bounced', error: r.error } }))
    // Only count it against the inbox if Gmail actually tried to deliver it
    if (!r.precheck) recordEvent(acc.user, 'bounce', { leadId: lead.id })
    log(`Bad address for ${lead.name}: ${r.error}`, 'failed')
    feed({ type: 'bounce', ...base, error: r.error })
  } else if (r.kind === 'auth') {
    feed({ type: 'failed', ...base, error: r.error })
    setAccountMeta(acc.user, { lastVerify: { ok: false, error: r.error, at: Date.now() } })
    pauseAccount(acc.user, 'Login failed. Check its App Password.')
  } else if (r.kind === 'content') {
    // Gmail blocked the message content. Retrying the same email won't help,
    // and it's a warning sign for the inbox, so stop this lead and rest the inbox.
    patchLead(lead.id, l => ({ seq: { ...l.seq, status: 'failed', error: r.error } }))
    feed({ type: 'failed', ...base, error: `Gmail blocked this email as spam/policy. ${r.error}` })
    pauseAccount(acc.user, 'Gmail flagged an email as spam. Resting this inbox for 24h. Check your copy for spammy words or links.', 24)
  } else if (r.kind === 'quota') {
    feed({ type: 'failed', ...base, error: r.error })
    pauseAccount(acc.user, 'Gmail rate-limited this inbox. Resting it for 24h.', 24)
  } else {
    const attempts = (lead.seq.attempts || 0) + 1
    const maxAttempts = Math.max(1, Number(s.maxAttempts) || 4)
    const retryMins = Math.max(1, Number(s.retryMins) || 15)
    patchLead(lead.id, l => ({ seq: { ...l.seq, attempts, nextAt: Date.now() + retryMins * 60000, status: attempts >= maxAttempts ? 'failed' : l.seq.status, error: r.error } }))
    log(`Send to ${lead.name} failed (attempt ${attempts}): ${r.error}`, 'failed')
    feed({ type: 'failed', ...base, attempt: attempts, willRetry: attempts < maxAttempts, retryMins, error: r.error })
  }
  return { idle: false }
}

// ── Health check: auto-pause an inbox with a bad bounce rate ──
function healthCheck() {
  const s = getSettings()
  if (s.autoPause === false) return
  const pct = Math.max(0.5, Number(s.bouncePausePct) || 5) / 100
  const min = Math.max(1, Number(s.bouncePauseMin) || 20)
  for (const a of accountsView()) {
    if (a.status === 'active' && a.cold7 >= min && a.bounceRate > pct) {
      pauseAccount(a.user, `Bounce rate ${(a.bounceRate * 100).toFixed(1)}% this week. Clean your list before resuming.`)
    }
  }
}

// ── Warmup ────────────────────────────────────────────────────
async function sendWarmup() {
  const s = getSettings()
  const pool = accountsView().filter(a => a.status !== 'paused' && a.loginOk !== false)
  if (pool.length < 2) return
  const needing = pool.filter(a => a.warm24 < a.warmTarget)
  if (!needing.length) return
  const from = needing[Math.floor(Math.random() * needing.length)]
  const others = pool.filter(a => a.user !== from.user)
  const to = others[Math.floor(Math.random() * others.length)]
  const r = await apiJSON('/api/warmup', { method: 'POST', body: { action: 'send', from: from.user, to: to.user, fromName: s.fromName } })
  if (r.success) recordEvent(from.user, 'warmup')
  else if (r.kind === 'auth') setAccountMeta(from.user, { lastVerify: { ok: false, error: r.error, at: Date.now() } })
  else if (r.error) log(`Warmup send from ${from.user} failed: ${r.error}`, 'failed')
}

let processQueue = []
let nextProcessAt = 0
async function processOneWarmupInbox() {
  const user = processQueue.shift()
  if (!user) return
  const r = await apiJSON('/api/warmup', { method: 'POST', body: { action: 'process', account: user, fromName: getSettings().fromName } })
  if (r.error) { log(`Warmup tidy-up on ${user} failed: ${r.error}`, 'failed'); return }
  for (let i = 0; i < (r.replied || 0); i++) recordEvent(user, 'warmup')
  if (r.rescued) log(`Warmup: moved ${r.rescued} email(s) out of spam on ${user}`, 'warn')
  setAccountMeta(user, { lastWarmupProcess: { at: Date.now(), ...r } })
}

// ── Inbox sync ────────────────────────────────────────────────
const AUTO_REPLY = /(automatic reply|auto[- ]?reply|out of (the )?office|away from the office|on leave|autoreply|thank you for (your email|contacting))/i
const UNSUB = /\b(unsubscribe|remove me|take me off|stop emailing|do not (email|contact)|don['’]t (email|contact)|not interested|no thanks|no thank you)\b/i

export function matchMessages(messages) {
  const inbox = get(KEYS.inbox) || { messages: [] }
  const known = new Map(inbox.messages.map(m => [m.id, m]))
  const leads = get(KEYS.pipeline) || []
  const byEmail = new Map(leads.filter(l => l.email).map(l => [lower(l.email), l]))
  const byMsgId = new Map()
  for (const l of leads) for (const snd of l.seq?.sends || []) if (snd.messageId) byMsgId.set(snd.messageId, l)

  const patches = new Map()
  const fresh = []
  for (const m of messages) {
    if (m.warmup) continue
    if (known.has(m.id)) { const k = known.get(m.id); if (k.seen !== m.seen) known.set(m.id, { ...k, seen: m.seen }); continue }
    const out = { ...m }
    if (m.isBounce) {
      out.kind = 'bounce'
      const lead = m.bouncedTo && byEmail.get(lower(m.bouncedTo))
      if (lead) {
        out.leadId = lead.id
        if (!lead.bounced) {
          patches.set(lead.id, { ...(patches.get(lead.id) || {}), bounced: true, seq: lead.seq ? { ...lead.seq, status: 'bounced', error: 'Bounced' } : lead.seq })
          recordEvent(lead.seq?.account || m.account, 'bounce', { leadId: lead.id })
          feed({ type: 'bounce', ...leadInfo(lead), from: lead.seq?.account || m.account, error: 'Bounced back (found in inbox)' })
        }
      }
    } else {
      const lead = byEmail.get(lower(m.fromEmail)) || byMsgId.get(m.inReplyTo) || (m.references || []).map(r => byMsgId.get(r)).find(Boolean)
      if (lead) {
        out.leadId = lead.id
        out.kind = AUTO_REPLY.test(m.subject) || AUTO_REPLY.test(String(m.text || '').slice(0, 300)) ? 'auto' : 'reply'
        if (out.kind === 'auto' && getSettings().stopOnAutoReply && lead.seq && ['queued', 'active'].includes(lead.seq.status)) {
          patches.set(lead.id, { ...(patches.get(lead.id) || {}), seq: { ...lead.seq, status: 'stopped', error: 'Stopped after an auto-reply' } })
        }
        if (out.kind === 'reply') {
          const negative = UNSUB.test(String(m.text || '').slice(0, 600))
          out.tag = negative ? 'Not interested' : null
          const prev = patches.get(lead.id) || {}
          patches.set(lead.id, {
            ...prev,
            lastReplyAt: m.date,
            stage: negative ? 'Not interested' : bumpStage(prev.stage || lead.stage, 'Replied'),
            seq: lead.seq ? { ...lead.seq, status: 'replied' } : lead.seq,
          })
          recordEvent(m.account, 'reply', { leadId: lead.id })
          log(`Reply from ${lead.name}${negative ? ' (looks like a no)' : ''}`, 'sent')
          const camp = (get(KEYS.campaigns) || []).find(c => c.id === lead.seq?.campaignId)
          feed({ type: 'reply', ...leadInfo(lead), from: m.account, negative, snippet: String(m.text || '').replace(/\s+/g, ' ').slice(0, 160), campaign: camp?.name, afterStep: (lead.seq?.sends || []).length })
        }
      } else {
        out.kind = 'other'
      }
    }
    fresh.push(out)
  }

  if (patches.size) updateLeads(list => list.map(l => patches.has(l.id) ? { ...l, ...patches.get(l.id) } : l))
  const all = [...fresh, ...known.values()].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 800)
  set(KEYS.inbox, i => ({ ...i, messages: all, lastSync: Date.now() }))
  return fresh
}

export async function syncInbox() {
  if (status.syncing) return
  const users = status.serverAccounts
  if (!users.length) return
  setStatus({ syncing: true })
  const results = await Promise.all(users.map(u => apiJSON('/api/inbox', { method: 'POST', body: { account: u, sinceDays: 14, limit: 60 }, timeoutMs: 58000 }).then(d => ({ u, d }))))
  const errors = {}
  const messages = []
  for (const { u, d } of results) {
    if (d.error) errors[u] = d.error
    else messages.push(...(d.messages || []))
  }
  matchMessages(messages)
  set(KEYS.inbox, i => ({ ...i, errors }))
  setStatus({ syncing: false, lastSync: Date.now() })
}

// ── Lock + main loop ──────────────────────────────────────────
function holdLock() {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null')
    if (!raw || raw.tab === tabId || Date.now() - raw.at > LOCK_STALE) {
      localStorage.setItem(LOCK_KEY, JSON.stringify({ tab: tabId, at: Date.now() }))
      return true
    }
    return false
  } catch { return true }
}

let busy = false
let nextColdAt = 0
let nextWarmAt = Date.now() + 30000
let nextSyncAt = Date.now() + 4000
let lastHealth = 0

// How long to wait before the next cold email.
//  • fixed:  a random gap between the min and max in Settings
//  • spread: share what's left of today's limit evenly across what's left of
//            the sending window, with ±40% randomness so it doesn't look robotic.
//            Never faster than the min gap, never slower than 20 minutes.
function nextGapMs(s) {
  const minMs = Math.max(1, Number(s.minGapSec) || 1) * 1000
  const maxMs = Math.max(minMs, (Number(s.maxGapSec) || 1) * 1000)
  if (s.pacing !== 'spread') return rand(minMs, maxMs)
  const view = accountsView()
  const left = view.filter(a => a.status === 'active').reduce((n, a) => n + a.remaining, 0)
  if (!left) return maxMs
  const msLeft = windowMsLeft(s, 'Australia/Adelaide')
  if (!msLeft) return maxMs
  const even = msLeft / left
  return Math.min(20 * 60000, Math.max(minMs, even * rand(0.6, 1.4)))
}

async function tick() {
  if (busy) return
  const holder = holdLock()
  if (!holder) { setStatus({ holder: false, message: 'Engine is running in another CRM tab' }); return }
  busy = true
  try {
    const s = getSettings()
    const now = Date.now()
    const windowOpen = inWindowTz(s, 'Australia/Adelaide')
    setStatus({ holder: true, windowOpen })

    if (now >= nextSyncAt && status.serverAccounts.length) {
      nextSyncAt = now + Math.max(2, s.inboxSyncMins) * 60000
      syncInbox() // runs alongside sending
    }

    if (!s.engineOn) { setStatus({ message: 'Sending is paused' }); return }

    if (now - lastHealth > 10 * 60000) { lastHealth = now; healthCheck() }

    if (now >= nextColdAt) {
      const r = await sendNextCold()
      if (r.idle) {
        nextColdAt = Date.now() + 15000
        setStatus({ message: r.why, nextColdAt: 0 })
      } else {
        nextColdAt = Date.now() + nextGapMs(s)
        setStatus({ message: 'Waiting for next send', nextColdAt })
      }
    } else {
      setStatus({ message: 'Waiting for next send', nextColdAt })
    }

    if (s.warmupEnabled) {
      const warmWindow = inWindowTz({ weekdaysOnly: false, anyTime: false, windowStart: s.warmupHourStart ?? 7, windowEnd: s.warmupHourEnd ?? 21 }, 'Australia/Adelaide')
      if (warmWindow && Date.now() >= nextWarmAt) {
        const gMin = Math.max(0.5, Number(s.warmupGapMin) || 2), gMax = Math.max(gMin, Number(s.warmupGapMax) || 6)
        nextWarmAt = Date.now() + rand(gMin, gMax) * 60000
        setStatus({ nextWarmAt })
        await sendWarmup()
      }
      if (Date.now() >= nextProcessAt && !processQueue.length) {
        processQueue = [...status.serverAccounts]
        nextProcessAt = Date.now() + 20 * 60000
      }
      if (processQueue.length) await processOneWarmupInbox()
    }
  } catch (e) {
    console.error(e)
    log(`Engine error: ${e.message}`, 'failed')
  } finally {
    busy = false
  }
}

export function sendNow() { nextColdAt = 0; tick() }
export function syncNow() { nextSyncAt = 0; tick() }

let started = false
export function useEngine() {
  useEffect(() => {
    if (started) return
    started = true
    loadServerAccounts().then(() => tick())
    const t = setInterval(tick, TICK_MS)
    const a = setInterval(loadServerAccounts, 10 * 60000)
    const release = () => {
      try { const raw = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null'); if (raw?.tab === tabId) localStorage.removeItem(LOCK_KEY) } catch {}
    }
    window.addEventListener('beforeunload', release)
    return () => { clearInterval(t); clearInterval(a); release(); started = false }
  }, [])
}

// Put leads into a campaign. Leads without an email, already replied, or
// bounced are skipped. Returns how many were enrolled.
export function enrollLeads(ids, campaignId) {
  const idSet = new Set(ids)
  const extra = parseExtra(getSettings().blockList)
  const builtIn = getSettings().blockBuiltIn !== false
  let n = 0
  updateLeads(list => list.map(l => {
    if (!idSet.has(l.id) || !l.email || l.bounced) return l
    if (blockReason(l, extra, { builtIn })) return l
    if (l.emailCheck?.status === 'invalid' && l.emailCheck.email === lower(l.email)) return l
    if (l.seq && ['active', 'replied'].includes(l.seq.status)) return l
    if (!l.seq?.sends?.length && hasBeenContacted(l.email)) return l
    n++
    return { ...l, seq: { campaignId, step: 0, status: 'queued', nextAt: Date.now(), sends: [], refs: [], enrolledAt: Date.now() } }
  }))
  return n
}

export function count24hAll() {
  return status.serverAccounts.reduce((s, u) => s + count24h(u, 'cold'), 0)
}
