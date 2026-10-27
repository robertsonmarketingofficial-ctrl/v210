import { findAccount, getAccounts, sendFrom, explainError } from '../../components/mailer'
import { processWarmupInbox } from '../../components/imap'
import { warmupMessage, warmupReply } from '../../components/warmupText'

// POST { action: 'send', from, to }   → one warmup email between two of your inboxes
// POST { action: 'process', account } → rescue warmup mail from spam, open + star it, reply to some
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()
  const { action, from, to, account, fromName } = req.body || {}
  const own = getAccounts().map(a => a.user.toLowerCase())

  if (action === 'send') {
    if (!own.includes(String(to || '').toLowerCase())) return res.status(200).json({ success: false, error: 'Warmup only sends between your own inboxes.' })
    const { subject, text } = warmupMessage(to, fromName)
    return res.status(200).json(await sendFrom({ from, to, subject, text, fromName }))
  }

  if (action === 'process') {
    const acc = findAccount(account)
    if (!acc) return res.status(200).json({ error: `${account} isn't configured on the server.` })
    try {
      const result = await processWarmupInbox(acc, own)
      let replied = 0
      for (const r of result.toReply) {
        const subject = /^re:/i.test(r.subject) ? r.subject : `Re: ${r.subject}`
        const sent = await sendFrom({ from: acc.user, to: r.to, subject, text: warmupReply(fromName), inReplyTo: r.messageId, references: r.references, fromName })
        if (sent.success) replied++
      }
      return res.status(200).json({ rescued: result.rescued, opened: result.opened, replied })
    } catch (err) {
      return res.status(200).json({ error: explainError(err) })
    }
  }

  res.status(400).json({ error: 'Unknown action' })
}
