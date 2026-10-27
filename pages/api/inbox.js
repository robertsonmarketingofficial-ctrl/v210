import { findAccount, getAccounts, explainError } from '../../components/mailer'
import { fetchRecent, markSeen } from '../../components/imap'

// One inbox per request so a slow mailbox can't push the whole sync past
// Vercel's time limit. The browser syncs all inboxes in parallel.
//   POST { account, sinceDays?, limit? }         → recent messages
//   POST { account, action: 'seen', uid }         → mark one as read in Gmail
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()
  const { account, sinceDays, limit, action, uid } = req.body || {}
  const acc = findAccount(account)
  if (!acc) return res.status(200).json({ error: `${account} isn't configured on the server.` })
  try {
    if (action === 'seen') {
      await markSeen(acc, uid)
      return res.status(200).json({ ok: true })
    }
    const own = getAccounts().map(a => a.user)
    const messages = await fetchRecent(acc, { sinceDays: Math.min(Number(sinceDays) || 14, 60), limit: Math.min(Number(limit) || 60, 150), ownAccounts: own })
    res.status(200).json({ messages })
  } catch (err) {
    res.status(200).json({ error: explainError(err) })
  }
}
