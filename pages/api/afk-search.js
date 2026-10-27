// Step 1 of AFK mode: search ONE suburb and return matching businesses.
//
// IMPORTANT — why this handles one suburb per call:
// It used to loop every suburb server-side in a single request. On Vercel
// that hits the default 10s function timeout after only ~3-4 suburbs
// (Google's pagination requires a 2s delay between pages), which silently
// capped every AFK run at roughly 60 leads no matter what target was set.
// The client now loops suburbs and calls this once each, exactly like Lead
// Finder's state sweep does, so there's no ceiling.

import { searchPlacesNew } from './search'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { niche, suburb, maxPages, state } = req.body
  const apiKey = process.env.GOOGLE_PLACES_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'Google Places API key not configured' })
  if (!niche || !suburb) return res.status(400).json({ error: 'niche and suburb required' })

  try {
    const result = await searchPlacesNew(niche, suburb, apiKey, maxPages || 3, state)
    if (result.error) return res.status(200).json({ leads: [], error: result.error })
    return res.status(200).json({ leads: result.leads || [], outOfState: result.outOfState || 0 })
  } catch (err) {
    return res.status(200).json({ leads: [], error: 'Search failed: ' + err.message })
  }
}
