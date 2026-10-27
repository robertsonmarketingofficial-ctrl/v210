// Browser side of the bounce check. Results are cached per address for 30
// days so the same email is never looked up twice in a row.

import { KEYS, get, set } from './store'
import { apiJSON } from './api'

const TTL = 30 * 86400000
const lower = (s) => String(s || '').trim().toLowerCase()

export function cachedCheck(email) {
  const r = (get(KEYS.verify) || {})[lower(email)]
  if (!r) return null
  if (r.status === 'unknown' && Date.now() - r.at > 3600000) return null
  if (Date.now() - r.at > TTL) return null
  return r
}

function save(results) {
  if (!results?.length) return
  set(KEYS.verify, m => {
    const next = { ...(m || {}) }
    for (const r of results) next[lower(r.email)] = { status: r.status, reason: r.reason, suggestion: r.suggestion || null, at: Date.now() }
    // keep the cache from growing forever
    const keys = Object.keys(next)
    if (keys.length > 20000) keys.sort((a, b) => next[a].at - next[b].at).slice(0, keys.length - 20000).forEach(k => delete next[k])
    return next
  })
}

// Check a list of emails. Uses the cache, looks up the rest 50 at a time.
// onProgress(done, total) is optional.
export async function checkEmails(emails, { force = false, onProgress } = {}) {
  const all = [...new Set((emails || []).map(lower).filter(Boolean))]
  const out = {}
  const todo = []
  for (const e of all) {
    const c = !force && cachedCheck(e)
    if (c) out[e] = c
    else todo.push(e)
  }
  let done = all.length - todo.length
  onProgress?.(done, all.length)
  for (let i = 0; i < todo.length; i += 50) {
    const batch = todo.slice(i, i + 50)
    const d = await apiJSON('/api/verify', { method: 'POST', body: { emails: batch }, timeoutMs: 55000 })
    const results = d.results || []
    save(results)
    for (const r of results) out[lower(r.email)] = { ...r, at: Date.now() }
    for (const e of batch) if (!out[e]) out[e] = { status: 'unknown', reason: d.error || 'No answer from the server', at: Date.now() }
    done += batch.length
    onProgress?.(done, all.length)
  }
  return out
}

export async function checkEmail(email, opts) {
  const r = await checkEmails([email], opts)
  return r[lower(email)] || { status: 'unknown', reason: 'Not checked' }
}

export const CHECK_LABEL = { valid: 'Deliverable', invalid: 'Would bounce', unknown: 'Not checked' }
export const CHECK_TONE = { valid: 'ok', invalid: 'bad', unknown: '' }
