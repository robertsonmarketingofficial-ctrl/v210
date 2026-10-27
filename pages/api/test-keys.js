// Checks the Google Places key with one tiny search.
export default async function handler(req, res) {
  const key = process.env.GOOGLE_PLACES_API_KEY
  if (!key) return res.status(200).json({ places: { status: 'missing', error: 'GOOGLE_PLACES_API_KEY is not set in Vercel.' } })
  try {
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id' },
      body: JSON.stringify({ textQuery: 'plumber adelaide', regionCode: 'AU' }),
    })
    const data = await r.json()
    res.status(200).json({ places: data.error ? { status: 'error', error: `${data.error.status || r.status}: ${data.error.message || ''}` } : { status: 'working' } })
  } catch (e) {
    res.status(200).json({ places: { status: 'error', error: e.message } })
  }
}
