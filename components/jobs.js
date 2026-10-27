// Background lead searches.
//
// Searches run here, outside any tab, so you can start several at once and
// switch to Pipeline, Campaigns or anywhere else while they keep going. Each
// search is a "job":
//   • search: one trade in one or more suburbs
//   • sweep:  one trade across every suburb in a state
//   • hunt:   AFK Hunter. Searches, checks websites, checks emails won't
//             bounce, and queues the good ones straight into a campaign
//             until it hits your target.
//
// Jobs are saved to the browser, so a refresh doesn't lose results. A job that
// was running when the page closed shows as "Interrupted" with a Resume button.

import { useEffect, useState } from 'react'
import { apiJSON } from './api'
import { KEYS, get, settings as getSettings, updateLeads, newLead } from './store'
import { blockReason, parseExtra } from './blocklist'
import { hasBeenContacted } from './tracker'
import { checkEmails, cachedCheck } from './verifyClient'
import { AU_STATES } from './tabs/helpers'
import { enrollLeads } from './engine'

const STORE = 'rm_search_jobs_v2'
const MAX_JOBS = 30
const lower = (s) => String(s || '').trim().toLowerCase()
const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

// ── State + subscriptions ─────────────────────────────────────
let jobs = load()
const listeners = new Set()
let persistTimer = null

function load() {
  if (typeof window === 'undefined') return []
  try {
    const list = JSON.parse(localStorage.getItem(STORE) || '[]')
    // Anything that was mid-run when the page closed is now interrupted
    return (Array.isArray(list) ? list : []).map(j => ['running', 'queued', 'checking'].includes(j.status) ? { ...j, status: 'interrupted' } : j)
  } catch { return [] }
}

// Saves at most once a second. (A plain debounce never fired while a search
// was busy, because every result reset the timer, so a refresh lost them.)
let lastSave = 0
function save() {
  persistTimer = null
  lastSave = Date.now()
  let list = jobs.slice(0, MAX_JOBS)
  // localStorage is small (about 5 MB, shared with your pipeline). If it's
  // full, drop the stored results of the oldest finished jobs first.
  for (let attempt = 0; attempt < 6; attempt++) {
    try { localStorage.setItem(STORE, JSON.stringify(list)); return } catch {
      const old = [...list].reverse().find(j => j.results?.length && !['running', 'checking'].includes(j.status))
      if (!old) return
      list = list.map(j => j.id === old.id ? { ...j, results: [], resultsDropped: true } : j)
    }
  }
}
function persist() {
  if (persistTimer) return
  persistTimer = setTimeout(save, Math.max(0, 1000 - (Date.now() - lastSave)))
}
if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => { if (persistTimer) { clearTimeout(persistTimer); save() } })

function emit() { listeners.forEach(fn => fn(jobs)); persist() }

function patch(jobId, fn) {
  jobs = jobs.map(j => j.id === jobId ? { ...j, ...(typeof fn === 'function' ? fn(j) : fn) } : j)
  emit()
}

const job = (jobId) => jobs.find(j => j.id === jobId)

export function useJobs() {
  const [list, setList] = useState(jobs)
  useEffect(() => { listeners.add(setList); setList(jobs); return () => listeners.delete(setList) }, [])
  return list
}

export function getJobs() { return jobs }

// ── Shared limits so 5 jobs don't hammer Google at once ───────
function semaphore(getLimit) {
  let active = 0
  const waiting = []
  const next = () => {
    while (waiting.length && active < Math.max(1, getLimit())) { active++; waiting.shift()() }
  }
  return async (fn) => {
    await new Promise(r => { waiting.push(r); next() })
    try { return await fn() } finally { active--; next() }
  }
}
const searchSlot = semaphore(() => Number(getSettings().searchConcurrency) || 2)
const scrapeSlot = semaphore(() => Number(getSettings().scrapeConcurrency) || 6)

// ── Creating jobs ─────────────────────────────────────────────
const SUBURB_STATE = {}
for (const s of AU_STATES) for (const sub of s.suburbs) SUBURB_STATE[sub] = s.short

function interleaved() {
  const lists = AU_STATES.map(s => s.suburbs)
  const out = []
  for (let i = 0; i < Math.max(...lists.map(l => l.length)); i++) for (const l of lists) if (l[i]) out.push(l[i])
  return out
}

export const REGIONS = [{ label: 'All of Australia', short: 'AUS' }, ...AU_STATES.map(s => ({ label: s.label, short: s.short }))]

export function placesFor(region) {
  if (region === 'AUS') return interleaved().map(p => ({ place: p, state: SUBURB_STATE[p] }))
  const st = AU_STATES.find(s => s.short === region)
  return st ? st.suburbs.map(p => ({ place: p, state: st.short })) : []
}

// "Plumber, Roofer" → ['Plumber','Roofer']; locations split on commas/new lines
export const splitList = (text) => [...new Set(String(text || '').split(/[\n,;]+/).map(x => x.trim()).filter(Boolean))]

function makeJob(base) {
  const j = {
    id: id(), createdAt: Date.now(), status: 'queued', results: [],
    progress: { done: 0, total: base.places.length, current: '' },
    scrape: { done: 0, total: 0 }, check: { done: 0, total: 0 },
    tally: { searched: 0, found: 0, withEmail: 0, blocked: 0, invalid: 0, emailedBefore: 0, queued: 0 },
    log: [], error: '', ...base,
  }
  jobs = [j, ...jobs].slice(0, MAX_JOBS)
  emit()
  run(j.id)
  return j
}

// One trade in one suburb (or a few suburbs typed in a list)
export function startSearch({ category, location, pages }) {
  const { place, state } = splitPlace(location)
  return makeJob({ kind: 'search', category, label: `${category} in ${location}`, places: [{ place, state }], pages: pages || getSettings().searchPages || 3 })
}

export function startSweep({ category, region, pages }) {
  const places = placesFor(region)
  const label = REGIONS.find(r => r.short === region)?.label || region
  return makeJob({ kind: 'sweep', category, label: `${category} across ${label}`, places, pages: pages || getSettings().searchPages || 3 })
}

export function startHunt({ category, region, campaignId, campaignName, goal, maxRating }) {
  const places = placesFor(region)
  const label = REGIONS.find(r => r.short === region)?.label || region
  return makeJob({ kind: 'hunt', category, label: `Hunting ${category} in ${label}`, places, pages: getSettings().searchPages || 3, campaignId, campaignName, goal: Math.max(1, Number(goal) || 100), maxRating: Number(maxRating) || 0 })
}

function splitPlace(location) {
  const m = String(location).trim().match(/^(.*?)[,\s]+(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)$/i)
  return m ? { place: m[1].trim(), state: m[2].toUpperCase() } : { place: String(location).trim(), state: SUBURB_STATE[String(location).trim()] || null }
}

export function stopJob(jobId) {
  const j = job(jobId)
  if (!j) return
  patch(jobId, { stopRequested: true, status: ['running', 'checking', 'queued'].includes(j.status) ? 'stopping' : j.status })
}

export function removeJob(jobId) {
  stopJob(jobId)
  jobs = jobs.filter(j => j.id !== jobId)
  emit()
}

export function clearFinished() {
  jobs = jobs.filter(j => ['running', 'checking', 'queued', 'stopping'].includes(j.status))
  emit()
}

export function resumeJob(jobId) {
  const j = job(jobId)
  if (!j || ['running', 'checking', 'queued', 'stopping'].includes(j.status)) return
  patch(jobId, { status: 'queued', stopRequested: false, error: '' })
  run(jobId)
}

// Re-check results' emails (e.g. after a DNS hiccup)
export async function recheckJob(jobId) {
  const j = job(jobId)
  if (!j) return
  await checkResults(jobId, true)
}

// ── Running ───────────────────────────────────────────────────
const running = new Set()

function addLog(jobId, text, type = 'info') {
  patch(jobId, j => ({ log: [...(j.log || []).slice(-150), { at: Date.now(), text, type }] }))
}

function bump(jobId, key, n = 1) {
  patch(jobId, j => ({ tally: { ...j.tally, [key]: (j.tally?.[key] || 0) + n } }))
}

const stopped = (jobId) => !job(jobId) || job(jobId).stopRequested

async function run(jobId) {
  if (running.has(jobId)) return
  running.add(jobId)
  try {
    const j0 = job(jobId)
    patch(jobId, { status: 'running', startedAt: j0.startedAt || Date.now() })
    const s = getSettings()
    const extra = parseExtra(s.blockList)
    const builtIn = s.blockBuiltIn !== false
    const seen = new Set((j0.results || []).map(r => r.id))
    const pipelineIds = new Set((get(KEYS.pipeline) || []).map(l => l.id))
    const start = j0.progress?.done || 0

    // Two suburbs at a time per job: while one suburb's websites are being
    // checked, the next suburb is already being searched.
    let idx = start
    const worker = async () => {
      while (!stopped(jobId)) {
        const j = job(jobId)
        if (j.kind === 'hunt' && j.tally.queued >= j.goal) break
        const i = idx++
        if (i >= j.places.length) break
        const { place, state } = j.places[i]
        patch(jobId, x => ({ progress: { ...x.progress, current: place } }))

        const d = await searchSlot(() => apiJSON('/api/search', { method: 'POST', body: { query: j.category, location: place, maxPages: j.pages, state }, timeoutMs: 60000 }))
        bump(jobId, 'searched')
        if (d.error) {
          addLog(jobId, `${place}: ${d.error}`, 'failed')
          if (/api key|not configured|PERMISSION|API_KEY|billing/i.test(d.error)) { patch(jobId, { error: d.error, stopRequested: true }); break }
        }
        if (d.blocked) bump(jobId, 'blocked', d.blocked)

        let leads = (d.leads || []).filter(l => !seen.has(l.id))
        leads.forEach(l => seen.add(l.id))
        // Your own Never email list (the built-in list is already applied on the server)
        const before = leads.length
        leads = leads.filter(l => !blockReason(l, extra, { builtIn }))
        if (before - leads.length) bump(jobId, 'blocked', before - leads.length)
        if (j.maxRating) leads = leads.filter(l => l.rating && l.rating < j.maxRating)
        leads = leads.map(l => ({ ...l, category: j.category, inPipeline: pipelineIds.has(l.id) }))
        bump(jobId, 'found', leads.length)
        patch(jobId, x => ({ results: [...x.results, ...leads], scrape: { ...x.scrape, total: x.scrape.total + leads.filter(l => l.website && !l.email).length } }))

        // Find emails on their websites
        await Promise.all(leads.filter(l => l.website && !l.email).map(l => scrapeSlot(async () => {
          if (stopped(jobId)) return
          const r = await apiJSON('/api/scrape', { method: 'POST', body: { website: l.website }, timeoutMs: 35000 })
          const email = r.email ? lower(r.email) : null
          const blocked = email && blockReason({ ...l, email }, extra, { builtIn })
          patch(jobId, x => ({
            scrape: { ...x.scrape, done: x.scrape.done + 1 },
            results: x.results.map(y => y.id === l.id ? { ...y, email: blocked ? null : email, blockedEmail: blocked ? email : undefined, contactedBefore: email ? hasBeenContacted(email) : false } : y),
          }))
          if (email && !blocked) bump(jobId, 'withEmail')
          if (blocked) bump(jobId, 'blocked')
        })))

        if (job(jobId)?.kind === 'hunt') await huntQueue(jobId, leads.map(l => l.id), place)
        patch(jobId, x => ({ progress: { ...x.progress, done: Math.max(x.progress.done, i + 1) } }))
      }
    }
    await Promise.all([worker(), worker()])

    if (job(jobId) && job(jobId).kind !== 'hunt' && getSettings().autoCheckFound && !stopped(jobId)) await checkResults(jobId)

    const j = job(jobId)
    if (!j) return
    const finished = j.progress.done >= j.places.length || (j.kind === 'hunt' && j.tally.queued >= j.goal)
    patch(jobId, { status: j.error ? 'failed' : j.stopRequested && !finished ? 'stopped' : 'done', finishedAt: Date.now(), progress: { ...j.progress, current: '' } })
    if (j.kind === 'hunt') {
      addLog(jobId, j.tally.queued >= j.goal ? `Done. ${j.tally.queued} leads queued in “${j.campaignName}”.` : j.stopRequested ? `Stopped with ${j.tally.queued} queued.` : `Ran out of suburbs. ${j.tally.queued} leads queued.`, 'sent')
      const camp = (get(KEYS.campaigns) || []).find(c => c.id === j.campaignId)
      if (camp && camp.status !== 'running') addLog(jobId, `“${camp.name}” is paused. Start it in Campaigns to begin sending.`, 'warn')
    }
  } catch (e) {
    console.error(e)
    patch(jobId, { status: 'failed', error: e.message })
  } finally {
    running.delete(jobId)
  }
}

// Bounce-check every email a job found
async function checkResults(jobId, force = false) {
  const j = job(jobId)
  const emails = (j?.results || []).filter(r => r.email).map(r => r.email)
  if (!emails.length) return
  patch(jobId, { status: 'checking', check: { done: 0, total: emails.length } })
  const res = await checkEmails(emails, { force, onProgress: (done, total) => patch(jobId, { check: { done, total } }) })
  patch(jobId, x => {
    const results = x.results.map(r => r.email && res[lower(r.email)] ? { ...r, check: res[lower(r.email)].status, checkReason: res[lower(r.email)].reason, suggestion: res[lower(r.email)].suggestion || null } : r)
    return { results, tally: { ...x.tally, invalid: results.filter(r => r.check === 'invalid').length } }
  })
  if (force) patch(jobId, j2 => ({ status: j2.status === 'checking' ? 'done' : j2.status }))
}

// AFK Hunter: check the new emails and queue the good ones into the campaign
async function huntQueue(jobId, ids, place) {
  const j = job(jobId)
  if (!j || stopped(jobId)) return
  const idSet = new Set(ids)
  const pipelineIds = new Set((get(KEYS.pipeline) || []).map(l => l.id))
  let candidates = j.results.filter(r => idSet.has(r.id) && r.email && !pipelineIds.has(r.id))
  const before = candidates.length
  candidates = candidates.filter(r => !hasBeenContacted(r.email))
  if (before - candidates.length) bump(jobId, 'emailedBefore', before - candidates.length)
  if (!candidates.length) return

  const checks = await checkEmails(candidates.map(c => c.email))
  const good = candidates.filter(c => checks[lower(c.email)]?.status !== 'invalid')
  const bad = candidates.length - good.length
  if (bad) bump(jobId, 'invalid', bad)

  const now = job(jobId)
  const room = Math.max(0, now.goal - now.tally.queued)
  const take = good.slice(0, room)
  if (!take.length) return
  updateLeads(list => {
    const have = new Set(list.map(l => l.id))
    return [...list, ...take.filter(l => !have.has(l.id)).map(l => newLead({ ...l, emailCheck: { email: lower(l.email), status: checks[lower(l.email)]?.status || 'unknown', reason: checks[lower(l.email)]?.reason, at: Date.now() } }))]
  })
  const n = enrollLeads(take.map(l => l.id), now.campaignId)
  bump(jobId, 'queued', n)
  patch(jobId, x => ({ results: x.results.map(r => take.some(t => t.id === r.id) ? { ...r, inPipeline: true, check: checks[lower(r.email)]?.status } : r) }))
  addLog(jobId, `${place}: +${n} queued (${job(jobId).tally.queued}/${now.goal})${bad ? `, ${bad} skipped as would-bounce` : ''}`, 'sent')
}

// Is any job still working? (for the sidebar badge)
export function activeJobCount(list = jobs) {
  return list.filter(j => ['running', 'checking', 'queued', 'stopping'].includes(j.status)).length
}

// For results tables: has this email been checked already?
export function checkFor(r) {
  if (r.check) return r.check
  const c = r.email && cachedCheck(r.email)
  return c ? c.status : null
}
