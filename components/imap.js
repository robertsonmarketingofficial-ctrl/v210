// Server-side only — reads Gmail over IMAP using the same App Passwords as
// SMTP. Powers the shared Inbox (replies + bounces) and Warmup (rescue from
// spam, mark important, reply).

import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'

function imapOptions(account) {
  const host = process.env.IMAP_HOST || 'imap.gmail.com'
  const port = Number(process.env.IMAP_PORT || 993)
  const secure = process.env.IMAP_SECURE ? process.env.IMAP_SECURE === 'true' : port === 993
  return {
    host, port, secure,
    auth: { user: account.user, pass: account.pass },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    tls: { rejectUnauthorized: !process.env.IMAP_INSECURE },
  }
}

export async function withImap(account, fn) {
  const client = new ImapFlow(imapOptions(account))
  client.on('error', () => {}) // socket errors surface through the awaited calls
  await client.connect()
  try {
    return await fn(client)
  } finally {
    try { await client.logout() } catch { try { client.close() } catch {} }
  }
}

const lower = (s) => String(s || '').trim().toLowerCase()

// Cut quoted history ("On Tue, ... wrote:") and signatures-in-quotes so the
// inbox shows what the person actually wrote.
export function stripQuoted(text = '') {
  const lines = String(text).replace(/\r/g, '').split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^On .{6,200}wrote:\s*$/i.test(l.trim())) break
    if (/^On .{6,200}$/i.test(l.trim()) && /wrote:\s*$/i.test((lines[i + 1] || '').trim())) break
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(l.trim())) break
    if (/^From:\s.+/i.test(l.trim()) && /^(Sent|Date):\s/i.test((lines[i + 1] || '').trim())) break
    if (/^>/.test(l)) continue
    out.push(l)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

const BOUNCE_SENDERS = /^(mailer-daemon|postmaster)@/i

// Pull the address that bounced out of a delivery-failure notice.
export function findBouncedAddress(text = '', ownAccounts = []) {
  const own = new Set(ownAccounts.map(lower))
  const t = String(text)
  const patterns = [
    /Final-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/i,
    /Original-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/i,
    /wasn['’]t delivered to\s+<?([^\s>]+@[^\s>]+?)>?\s/i,
    /delivery to the following recipient[s]? failed[^\n]*\n\s*<?([^\s>]+@[^\s>]+)>?/i,
    /address couldn['’]t be found[^@]*?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i,
  ]
  for (const p of patterns) {
    const m = t.match(p)
    if (m && !own.has(lower(m[1]))) return lower(m[1]).replace(/[.,;]+$/, '')
  }
  const all = t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []
  const candidate = all.map(lower).find(e => !own.has(e) && !BOUNCE_SENDERS.test(e) && !e.endsWith('google.com') && !e.endsWith('googlemail.com'))
  return candidate || null
}

const refsOf = (parsed) => {
  const r = parsed.references
  if (!r) return []
  return Array.isArray(r) ? r : String(r).split(/\s+/).filter(Boolean)
}

/**
 * Recent INBOX messages for one account, newest first.
 * Messages between your own inboxes are tagged `warmup` so the Inbox view
 * can hide them.
 */
export async function fetchRecent(account, { sinceDays = 14, limit = 60, ownAccounts = [] } = {}) {
  const own = new Set(ownAccounts.map(lower))
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock('INBOX')
    try {
      const since = new Date(Date.now() - sinceDays * 86400000)
      let uids = await client.search({ since }, { uid: true })
      if (!uids || !uids.length) return []
      uids = uids.slice(-limit)
      // Collect first, parse after (never await inside the fetch loop).
      const raw = []
      for await (const msg of client.fetch(uids.join(','), { uid: true, flags: true, envelope: true, source: true }, { uid: true })) raw.push(msg)
      const out = []
      for (const msg of raw) {
        let parsed = null
        try { parsed = await simpleParser(msg.source) } catch {}
        const fromAddr = lower(msg.envelope?.from?.[0]?.address || parsed?.from?.value?.[0]?.address)
        const fromName = msg.envelope?.from?.[0]?.name || parsed?.from?.value?.[0]?.name || ''
        const rawText = parsed?.text || (parsed?.html ? String(parsed.html).replace(/<[^>]+>/g, ' ') : '') || ''
        const isBounce = BOUNCE_SENDERS.test(fromAddr)
        out.push({
          id: `${account.user}:${msg.uid}`,
          uid: msg.uid,
          account: account.user,
          messageId: msg.envelope?.messageId || parsed?.messageId || null,
          inReplyTo: msg.envelope?.inReplyTo || parsed?.inReplyTo || null,
          references: parsed ? refsOf(parsed) : [],
          fromEmail: fromAddr,
          fromName,
          subject: msg.envelope?.subject || parsed?.subject || '(no subject)',
          date: (msg.envelope?.date || parsed?.date || new Date()).toISOString?.() || new Date().toISOString(),
          seen: msg.flags ? msg.flags.has('\\Seen') : false,
          warmup: own.has(fromAddr),
          isBounce,
          bouncedTo: isBounce ? findBouncedAddress(rawText, ownAccounts) : null,
          text: (isBounce ? rawText : stripQuoted(rawText)).slice(0, 5000),
        })
      }
      return out.sort((a, b) => new Date(b.date) - new Date(a.date))
    } finally {
      lock.release()
    }
  })
}

export async function markSeen(account, uid) {
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock('INBOX')
    try { await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }) } finally { lock.release() }
    return true
  })
}

async function findJunkFolder(client) {
  const boxes = await client.list()
  const junk = boxes.find(b => b.specialUse === '\\Junk')
  return junk?.path || boxes.find(b => /spam|junk/i.test(b.path))?.path || null
}

/**
 * Warmup housekeeping for ONE inbox:
 *  1. Move any warmup emails (from your other inboxes) out of Spam.
 *  2. Open unread warmup emails, star them, mark them Important.
 * Returns the warmup emails worth replying to; the API route sends replies.
 */
export async function processWarmupInbox(account, ownAccounts, { maxReplies = 6 } = {}) {
  const others = ownAccounts.map(lower).filter(a => a !== lower(account.user))
  if (!others.length) return { rescued: 0, opened: 0, toReply: [] }
  const fromAny = others.length === 1 ? { from: others[0] } : { or: others.map(a => ({ from: a })) }
  const since = new Date(Date.now() - 4 * 86400000)

  return withImap(account, async (client) => {
    let rescued = 0
    const junk = await findJunkFolder(client)
    if (junk) {
      const lock = await client.getMailboxLock(junk)
      try {
        const uids = await client.search({ ...fromAny, since }, { uid: true })
        if (uids?.length) {
          await client.messageMove(uids.join(','), 'INBOX', { uid: true })
          rescued = uids.length
        }
      } finally { lock.release() }
    }

    const toReply = []
    let opened = 0
    const lock = await client.getMailboxLock('INBOX')
    try {
      const uids = await client.search({ ...fromAny, since, seen: false }, { uid: true })
      if (uids?.length) {
        for await (const msg of client.fetch(uids.join(','), { uid: true, envelope: true, headers: ['references'] }, { uid: true })) {
          const subject = msg.envelope?.subject || ''
          const depth = (subject.match(/^(re:\s*)+/i)?.[0].match(/re:/gi) || []).length
          // Keep threads short and natural: reply to fresh warmup emails
          // about 60% of the time, never past a couple of back-and-forths.
          if (toReply.length < maxReplies && depth < 2 && Math.random() < 0.6) {
            const refs = String(msg.headers || '').replace(/^references:\s*/i, '').split(/\s+/).filter(s => s.startsWith('<'))
            toReply.push({
              to: lower(msg.envelope?.from?.[0]?.address),
              subject,
              messageId: msg.envelope?.messageId,
              references: [...refs, msg.envelope?.messageId].filter(Boolean),
            })
          }
        }
        await client.messageFlagsAdd(uids.join(','), ['\\Seen', '\\Flagged'], { uid: true })
        try { await client.messageFlagsAdd(uids.join(','), ['\\Important'], { uid: true, useLabels: true }) } catch {}
        opened = uids.length
      }
    } finally { lock.release() }

    return { rescued, opened, toReply }
  })
}
