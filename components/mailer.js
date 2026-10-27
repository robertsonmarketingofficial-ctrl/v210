// Server-side only — sends email via Gmail SMTP (nodemailer).
//
// v205: the BROWSER decides which inbox sends each email (round-robin with a
// per-inbox daily cap, see components/engine.js). The server just sends from
// the account it's told to use. That keeps rotation, caps and warmup logic in
// one place, and lets follow-ups go out from the same inbox, in the same
// thread, as the first email.
//
// CONFIG (Vercel env vars, comma-separated, same order):
//   GMAIL_USERS=one@gmail.com,two@gmail.com,...
//   GMAIL_APP_PASSWORDS=abcd efgh ijkl mnop,...
//   (single account: GMAIL_USER + GMAIL_APP_PASSWORD also works)
// Optional: EMAIL_FROM_NAME, SMTP_HOST / SMTP_PORT / SMTP_SECURE (tests).

import nodemailer from 'nodemailer'

const cleanUser = (v = '') => v.trim().replace(/^["']|["']$/g, '').trim()
const cleanPass = (v = '') => v.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '')

export function getAccounts() {
  const users = (process.env.GMAIL_USERS || '').split(',').map(cleanUser).filter(Boolean)
  const passes = (process.env.GMAIL_APP_PASSWORDS || '').split(',').map(cleanPass).filter(Boolean)
  if (users.length && users.length === passes.length) return users.map((user, i) => ({ user, pass: passes[i] }))
  if (users.length && users.length !== passes.length) {
    console.error(`GMAIL_USERS has ${users.length} entries but GMAIL_APP_PASSWORDS has ${passes.length}; they must match.`)
  }
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    return [{ user: cleanUser(process.env.GMAIL_USER), pass: cleanPass(process.env.GMAIL_APP_PASSWORD) }]
  }
  return []
}

export function findAccount(user) {
  const u = String(user || '').trim().toLowerCase()
  return getAccounts().find(a => a.user.toLowerCase() === u) || null
}

export function isPermanentFailure(err) {
  const m = (err?.message || String(err || '')).toLowerCase()
  return err?.code === 'EAUTH' || err?.responseCode === 535 || err?.responseCode === 534 ||
    m.includes('invalid login') || m.includes('username and password not accepted') ||
    m.includes('authentication failed') || m.includes('application-specific password required') ||
    m.includes('invalid credentials') || err?.authenticationFailed === true
}

// Gmail refused the message itself (spam/policy/content), not the address.
// Not the lead's fault, so it shouldn't mark them as bounced.
function isContentBlock(err) {
  const m = (err?.message || '').toLowerCase()
  return /5\.7\.[0-9]/.test(m) && /(spam|unsolicited|policy|security issue|blocked|suspicious|content)/.test(m) && !/user unknown|does not exist|no such user/.test(m)
}

function isRecipientFailure(err) {
  const m = (err?.message || '').toLowerCase()
  if (isContentBlock(err)) return false
  return err?.code === 'EENVELOPE' || err?.responseCode === 553 ||
    (err?.responseCode === 550 && !m.includes('5.4.5')) ||
    m.includes('recipient address rejected') || m.includes('no such user')
}

function isQuotaFailure(err) {
  const m = (err?.message || '').toLowerCase()
  return m.includes('daily user sending limit') || m.includes('sending limit exceeded') ||
    m.includes('5.4.5') || err?.responseCode === 421 || err?.responseCode === 454 || m.includes('rate limit')
}

export function explainError(err) {
  const raw = err?.message || String(err || 'Unknown error')
  const m = raw.toLowerCase()
  if (m.includes('application-specific password required') || err?.responseCode === 534)
    return `Gmail needs an App Password, not the normal password. Turn on 2-Step Verification, then make one at myaccount.google.com/apppasswords. [${raw}]`
  if (isPermanentFailure(err)) return `Gmail rejected the login. Check this address and its 16-letter App Password. [${raw}]`
  if (err?.code === 'ETIMEDOUT' || err?.code === 'ECONNECTION' || m.includes('timeout') || m.includes('greeting never received'))
    return `Couldn't reach Gmail in time (${err?.code || 'timeout'}). Usually temporary. [${raw}]`
  if (isQuotaFailure(err)) return `Gmail is rate-limiting this inbox: ${raw}`
  if (isRecipientFailure(err)) return `Address rejected: ${raw}`
  return raw
}

function smtpOptions(account) {
  const host = process.env.SMTP_HOST
  if (host) {
    const port = Number(process.env.SMTP_PORT || 587)
    return { host, port, secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465, auth: { user: account.user, pass: account.pass } }
  }
  return { host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: account.user, pass: account.pass } }
}

// Fresh connection per send — pooled sockets die when Vercel freezes the
// function between requests.
function transport(account) {
  return nodemailer.createTransport({
    ...smtpOptions(account),
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000, dnsTimeout: 8000,
  })
}

export async function verifyAccounts() {
  const accounts = getAccounts()
  const results = await Promise.all(accounts.map(async (a) => {
    const started = Date.now()
    try {
      await transport(a).verify()
      return { user: a.user, ok: true, ms: Date.now() - started }
    } catch (err) {
      return { user: a.user, ok: false, error: explainError(err), code: err.code || null, ms: Date.now() - started }
    }
  }))
  return {
    accountCount: accounts.length,
    okCount: results.filter(r => r.ok).length,
    accounts: results,
    passwordLengths: accounts.map(a => a.pass.length),
  }
}

const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim())

/**
 * Send one plain-text email from ONE specific account. No fallback to other
 * inboxes: the browser picked this inbox on purpose (rotation, threading).
 *
 * Returns { success:true, messageId, sentFrom } or
 *         { success:false, error, kind: 'recipient'|'auth'|'quota'|'temporary'|'config' }
 */
export async function sendFrom({ from, to, subject, text, inReplyTo, references, fromName }) {
  const account = findAccount(from)
  if (!account) {
    const n = getAccounts().length
    return {
      success: false, kind: 'config',
      error: n ? `${from} isn't in GMAIL_USERS on the server.` : 'No Gmail accounts configured. Set GMAIL_USERS and GMAIL_APP_PASSWORDS in Vercel, then redeploy.',
    }
  }
  const recipient = String(to || '').trim()
  if (!validEmail(recipient)) return { success: false, kind: 'recipient', precheck: true, error: `"${to}" isn't a valid email address` }

  const headers = {}
  if (inReplyTo) headers['In-Reply-To'] = inReplyTo
  if (references) headers['References'] = Array.isArray(references) ? references.join(' ') : references

  try {
    const info = await transport(account).sendMail({
      from: { name: fromName || process.env.EMAIL_FROM_NAME || 'Callum Robertson', address: account.user },
      to: recipient,
      subject: subject || 'Quick question',
      text,
      headers,
    })
    if (info.rejected?.length && !info.accepted?.length) {
      return { success: false, kind: 'recipient', error: `Address rejected by Gmail: ${info.rejected.join(', ')}` }
    }
    return { success: true, messageId: info.messageId, sentFrom: account.user }
  } catch (err) {
    console.error(`[mailer] ${account.user} -> ${recipient} failed:`, err.code, err.responseCode, err.message)
    const kind = isQuotaFailure(err) ? 'quota' : isContentBlock(err) ? 'content' : isRecipientFailure(err) ? 'recipient' : isPermanentFailure(err) ? 'auth' : 'temporary'
    return { success: false, kind, error: explainError(err) }
  }
}
