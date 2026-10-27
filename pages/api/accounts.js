import { getAccounts, verifyAccounts } from '../../components/mailer'

// GET  → which inboxes are configured (addresses only, never passwords)
// POST → actually log in to each one over SMTP and report what works
export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      return res.status(200).json({ accounts: getAccounts().map(a => a.user) })
    }
    if (req.method === 'POST') return res.status(200).json(await verifyAccounts())
    res.status(405).end()
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
