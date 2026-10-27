// Tiny shared store backed by localStorage. Every tab component and the send
// engine read and write through here, so nothing works off stale copies.
// Data still lives in this browser only — back it up from Settings.

import { useEffect, useState, useCallback } from 'react'

const cache = new Map()
const subs = new Map()

export const KEYS = {
  pipeline: 'rmv2_pipeline',
  searches: 'rmv2_searches',
  campaigns: 'rm_campaigns',
  settings: 'rm_settings',
  accounts: 'rm_accounts',
  inbox: 'rm_inbox',
  engineLog: 'rm_engine_log',
  feed: 'rm_send_feed',
  verify: 'rm_email_checks',
}

export const DEFAULT_SETTINGS = {
  // Sending
  perInboxCap: 35,
  windowStart: 8,
  windowEnd: 17,
  anyTime: false,
  weekdaysOnly: true,
  leadLocalTime: true,
  pacing: 'spread', // 'spread' = space sends evenly across the day, 'fixed' = random gap below
  minGapSec: 45,
  maxGapSec: 180,
  fromName: 'Callum Robertson',
  maxAttempts: 4,
  retryMins: 15,
  // Bounce protection
  verifyBeforeSend: true,
  sendIfUncheckable: true,
  autoPause: true,
  bouncePausePct: 5,
  bouncePauseMin: 20,
  // Who never gets emailed
  blockBuiltIn: true,
  blockList: '',
  // Warmup
  warmupEnabled: true,
  warmupStart: 5,
  warmupStep: 2,
  warmupMax: 20,
  warmupHourStart: 7,
  warmupHourEnd: 21,
  warmupGapMin: 2,
  warmupGapMax: 6,
  // Replies
  inboxSyncMins: 5,
  stopOnAutoReply: false,
  // Lead search
  searchPages: 3,
  searchConcurrency: 2,
  scrapeConcurrency: 6,
  autoCheckFound: true,
  // App
  engineOn: false,
  fx: 'storm',
}

const DEFAULTS = {
  [KEYS.pipeline]: [],
  [KEYS.searches]: [],
  [KEYS.campaigns]: [],
  [KEYS.settings]: DEFAULT_SETTINGS,
  [KEYS.accounts]: {},
  [KEYS.inbox]: { messages: [], lastSync: 0, errors: {} },
  [KEYS.engineLog]: [],
  [KEYS.feed]: [],
  [KEYS.verify]: {},
}

function read(key) {
  if (cache.has(key)) return cache.get(key)
  let v = DEFAULTS[key]
  try {
    const raw = localStorage.getItem(key)
    if (raw) v = JSON.parse(raw)
  } catch {}
  if (key === KEYS.settings) v = { ...DEFAULT_SETTINGS, ...(v || {}) }
  cache.set(key, v)
  return v
}

export function get(key) { return read(key) }

export function set(key, value) {
  const next = typeof value === 'function' ? value(read(key)) : value
  cache.set(key, next)
  try { localStorage.setItem(key, JSON.stringify(next)) } catch (e) { console.error('Save failed', key, e) }
  ;(subs.get(key) || []).forEach(fn => fn(next))
  return next
}

export function subscribe(key, fn) {
  if (!subs.has(key)) subs.set(key, new Set())
  subs.get(key).add(fn)
  return () => subs.get(key).delete(fn)
}

// Another tab wrote to localStorage — drop our cached copy so we re-read.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (!e.key || !cache.has(e.key)) return
    cache.delete(e.key)
    const v = read(e.key)
    ;(subs.get(e.key) || []).forEach(fn => fn(v))
  })
}

export function useStore(key) {
  const [value, setValue] = useState(() => read(key))
  useEffect(() => subscribe(key, setValue), [key])
  const update = useCallback((v) => set(key, v), [key])
  return [value, update]
}

// ── Lead helpers ──────────────────────────────────────────────

export const STAGES = ['New', 'Contacted', 'Replied', 'Interested', 'Meeting booked', 'Won', 'Not interested']

export function updateLeads(fn) { return set(KEYS.pipeline, list => fn(list || [])) }

export function patchLead(id, patch) {
  return updateLeads(list => list.map(l => l.id === id ? { ...l, ...(typeof patch === 'function' ? patch(l) : patch) } : l))
}

export function newLead(lead) {
  return {
    ...lead,
    stage: lead.stage || 'New',
    notes: lead.notes || '',
    addedAt: lead.addedAt || new Date().toISOString(),
  }
}

// Old versions used other stage names — fold them into the new set once.
export function migrateLeads() {
  const map = { 'Proposal sent': 'Interested', 'Closed': 'Won' }
  const list = read(KEYS.pipeline) || []
  if (list.some(l => map[l.stage])) updateLeads(ls => ls.map(l => map[l.stage] ? { ...l, stage: map[l.stage] } : l))
}

export function settings() { return read(KEYS.settings) }
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
