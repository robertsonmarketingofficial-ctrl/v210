import { verifyMany } from '../../components/verifier.js'

// POST { emails: [...] } → { results: [{ email, status: 'valid'|'invalid'|'unknown', reason }] }
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const emails = Array.isArray(req.body?.emails) ? req.body.emails : req.body?.email ? [req.body.email] : []
  if (!emails.length) return res.status(400).json({ error: 'emails required' })
  try {
    res.status(200).json({ results: await verifyMany(emails) })
  } catch (e) {
    res.status(200).json({ error: `Check failed: ${e.message}`, results: [] })
  }
}
