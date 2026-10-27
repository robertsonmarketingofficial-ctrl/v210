// Server-side only. Checks whether an email address can actually receive mail
// BEFORE we send to it, so dead addresses never count as bounces against your
// Gmail inboxes.
//
// What it checks (fast, no email is sent):
//   1. The address is well-formed (no spaces, junk characters, double dots)
//   2. The domain isn't an obvious typo (gmial.com, .com.au.au, .con)
//   3. The domain isn't a throwaway/disposable mail service
//   4. The domain exists and has a working mail server (MX record).
//      Expired websites and made-up domains fail here, and that's where most
//      cold-email bounces come from.
//
// What it can't check: whether the exact mailbox (e.g. bob@) exists on a real
// domain. That needs a direct SMTP probe on port 25, which Vercel blocks.
// Bounces like that are still caught afterwards from your inbox.

import { promises as dns } from 'dns'

const SYNTAX = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/

const TYPO_DOMAINS = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gamil.com': 'gmail.com',
  'gmail.co': 'gmail.com', 'gmail.com.au': 'gmail.com', 'gmaill.com': 'gmail.com', 'gnail.com': 'gmail.com',
  'hotmial.com': 'hotmail.com', 'hotmail.co': 'hotmail.com', 'hotmal.com': 'hotmail.com',
  'outlok.com': 'outlook.com', 'outloo.com': 'outlook.com', 'yaho.com': 'yahoo.com', 'yahoo.co': 'yahoo.com',
  'bigpond.com.au': null, 'bigpnd.com': 'bigpond.com', 'bigpond.co': 'bigpond.com', 'optusnet.com': 'optusnet.com.au',
  'iinet.com': 'iinet.net.au', 'icloud.co': 'icloud.com',
}
const BAD_TLDS = /\.(con|cmo|ocm|comm|om|co\.uu|com\.a|com\.u|au\.au|com\.au\.au|net\.au\.au)$/

const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org',
  'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com',
  'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com'])

// Placeholder addresses web designers leave on template sites
const PLACEHOLDER = /^(your|yourname|name|email|example|test|user|someone|me|info)@(example|domain|yourdomain|company|website|email|mysite|yoursite)\./

const mxCache = new Map()

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('DNS timeout'), { code: 'ETIMEOUT' })), ms))])
}

async function mailServers(domain) {
  if (mxCache.has(domain)) return mxCache.get(domain)
  const p = (async () => {
    try {
      const mx = await withTimeout(dns.resolveMx(domain), 5000)
      const real = (mx || []).filter(r => r.exchange && r.exchange !== '.')
      if (real.length) return { ok: true, mx: real.sort((a, b) => a.priority - b.priority).map(r => r.exchange) }
      if (mx && mx.length) return { ok: false, reason: 'This domain says it doesn’t accept email' }
    } catch (e) {
      if (e.code === 'ETIMEOUT' || e.code === 'ESERVFAIL' || e.code === 'ECONNREFUSED') return { ok: null, reason: 'DNS lookup timed out' }
      if (e.code !== 'ENODATA' && e.code !== 'ENOTFOUND') return { ok: null, reason: `DNS error ${e.code || ''}`.trim() }
      if (e.code === 'ENOTFOUND') return { ok: false, reason: 'Domain doesn’t exist (website likely expired)' }
    }
    // No MX record: mail falls back to the A record only in theory. In practice
    // almost every one of these bounces.
    try {
      await withTimeout(dns.resolve4(domain), 4000)
      return { ok: false, reason: 'Domain has no mail server set up' }
    } catch {
      return { ok: false, reason: 'Domain doesn’t exist (website likely expired)' }
    }
  })()
  mxCache.set(domain, p)
  return p
}

export function normaliseEmail(raw) {
  return String(raw || '')
    .trim()
    .replace(/^mailto:/i, '')
    .replace(/\?.*$/, '')
    .replace(/^[<("'\s]+|[>)"'\s.,;:]+$/g, '')
    .toLowerCase()
}

// Safety net: if the server's own DNS is broken, every domain would look
// dead. Check a domain that definitely has mail first, and if that fails,
// report "couldn't check" instead of marking good leads as bad.
let dnsOk = null
let dnsCheckedAt = 0
async function dnsWorks() {
  if (dnsOk !== null && Date.now() - dnsCheckedAt < 60000) return dnsOk
  try { const mx = await withTimeout(dns.resolveMx('gmail.com'), 5000); dnsOk = !!(mx && mx.length) } catch { dnsOk = false }
  dnsCheckedAt = Date.now()
  return dnsOk
}

export async function verifyEmail(raw) {
  const email = normaliseEmail(raw)
  if (!email) return { email, status: 'invalid', reason: 'No email address' }
  if (/\s/.test(email) || email.includes('..') || !SYNTAX.test(email)) return { email, status: 'invalid', reason: 'Not a valid email address' }
  const domain = email.split('@')[1]
  if (PLACEHOLDER.test(email)) return { email, status: 'invalid', reason: 'Placeholder address from a website template' }
  if (domain in TYPO_DOMAINS && TYPO_DOMAINS[domain]) {
    return { email, status: 'invalid', reason: `Looks like a typo of ${TYPO_DOMAINS[domain]}`, suggestion: email.replace(/@.*/, '@' + TYPO_DOMAINS[domain]) }
  }
  if (BAD_TLDS.test(domain)) return { email, status: 'invalid', reason: 'Domain ending looks mistyped' }
  if (DISPOSABLE.has(domain)) return { email, status: 'invalid', reason: 'Throwaway email service' }
  if (!(await dnsWorks())) return { email, status: 'unknown', reason: 'Couldn’t reach DNS to check' }
  const mx = await mailServers(domain)
  if (mx.ok === true) return { email, status: 'valid', reason: 'Mail server found', mx: mx.mx[0] }
  if (mx.ok === false) return { email, status: 'invalid', reason: mx.reason }
  return { email, status: 'unknown', reason: mx.reason || 'Couldn’t check right now' }
}

export async function verifyMany(list) {
  const emails = [...new Set((list || []).map(normaliseEmail).filter(Boolean))].slice(0, 100)
  const out = []
  // 10 lookups at a time
  for (let i = 0; i < emails.length; i += 10) {
    out.push(...await Promise.all(emails.slice(i, i + 10).map(verifyEmail)))
  }
  return out
}
