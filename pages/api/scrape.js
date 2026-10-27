import { scrapeEmail } from '../../components/scraper'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()
  try {
    const email = await scrapeEmail(req.body?.website)
    res.status(200).json({ email: email || null })
  } catch {
    res.status(200).json({ email: null })
  }
}
