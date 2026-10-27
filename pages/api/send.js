import { sendFrom } from '../../components/mailer'

// Sends ONE email from ONE named inbox. The browser's send engine decides
// which inbox, when, and enforces the daily caps.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()
  const { from, to, subject, text, inReplyTo, references, fromName } = req.body || {}
  if (!from || !to || !text) return res.status(400).json({ success: false, kind: 'config', error: 'from, to and text are required' })
  const result = await sendFrom({ from, to, subject, text, inReplyTo, references, fromName })
  res.status(200).json(result)
}
