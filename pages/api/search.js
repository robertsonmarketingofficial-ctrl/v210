import { blockReason } from '../../components/blocklist.js'
// Uses Places API (New) — a POST request with a JSON body and a required
// "field mask" header telling Google exactly which fields to return.
// Unlike the old Legacy API, this returns full details (phone, website,
// rating) in a single call — no separate "place details" request needed.

function cleanName(name) {
  if (!name) return null
  return name.replace(/\s*[-–|]\s*(Pty Ltd|Pty\. Ltd\.|PTY LTD|LLC|Inc\.|Ltd\.?)$/i, '')
    .replace(/&#\d+;/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ').trim()
}

function isAustralianAddress(addr) {
  if (!addr) return false
  return /\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT|New South Wales|Victoria|Queensland|South Australia|Western Australia|Tasmania|Northern Territory|Australian Capital Territory|Australia)\b/i.test(addr)
}

// ---- STATE LOCKING ----
// Searching "landscapers Richmond, Australia" lets Google pick ANY Richmond
// (VIC, NSW, SA, TAS...) or widen the search to anywhere in the country when
// a suburb has few matches — which is how a VIC sweep ended up full of WA
// businesses. When a state is known we (1) put the full state name in the
// query and (2) drop any result whose address is in a different state.

export const STATE_NAMES = {
  NSW: 'New South Wales', VIC: 'Victoria', QLD: 'Queensland', SA: 'South Australia',
  WA: 'Western Australia', TAS: 'Tasmania', ACT: 'Australian Capital Territory', NT: 'Northern Territory',
}
const STATE_CODES = Object.keys(STATE_NAMES)

function normaliseState(s) {
  if (!s) return null
  const t = String(s).trim().toUpperCase()
  if (STATE_NAMES[t]) return t
  return STATE_CODES.find(code => STATE_NAMES[code].toUpperCase() === t) || null
}

// "Richmond VIC" / "Richmond, Victoria" -> { place: 'Richmond', state: 'VIC' }
export function parseLocation(location, explicitState) {
  let place = String(location || '').trim()
  let state = normaliseState(explicitState)
  const alternatives = [...STATE_CODES, ...Object.values(STATE_NAMES)].join('|')
  const m = place.match(new RegExp(`^(.*?)[,\\s]+(${alternatives})$`, 'i'))
  if (m) {
    state = state || normaliseState(m[2])
    place = m[1].trim()
  }
  return { place, state }
}

function stateFromPostcode(pc) {
  const n = Number(pc)
  if ((n >= 2600 && n <= 2618) || (n >= 2900 && n <= 2920) || (n >= 200 && n <= 299)) return 'ACT'
  if ((n >= 1000 && n <= 2599) || (n >= 2619 && n <= 2899) || (n >= 2921 && n <= 2999)) return 'NSW'
  if ((n >= 3000 && n <= 3999) || (n >= 8000 && n <= 8999)) return 'VIC'
  if ((n >= 4000 && n <= 4999) || (n >= 9000 && n <= 9999)) return 'QLD'
  if (n >= 5000 && n <= 5999) return 'SA'
  if (n >= 6000 && n <= 6999) return 'WA'
  if (n >= 7000 && n <= 7999) return 'TAS'
  if (n >= 800 && n <= 999) return 'NT'
  return null
}

// Google formats AU addresses as "12 Smith St, Richmond VIC 3121, Australia"
export function detectState(address) {
  if (!address) return null
  const withCode = [...address.matchAll(/\b(NSW|VIC|QLD|SA|WA|TAS|ACT|NT)\s+(\d{3,4})\b/g)]
  if (withCode.length) return withCode[withCode.length - 1][1]
  const pc = address.match(/\b(\d{4})\b(?!.*\b\d{4}\b)/)
  if (pc) { const s = stateFromPostcode(pc[1]); if (s) return s }
  const bare = [...address.matchAll(/\b(NSW|VIC|QLD|SA|WA|TAS|ACT|NT)\b/g)]
  if (bare.length) return bare[bare.length - 1][1]
  for (const code of STATE_CODES) if (address.includes(STATE_NAMES[code])) return code
  return null
}

function cleanPhone(phone) {
  if (!phone) return null
  const digits = phone.replace(/[^\d+]/g, '')
  const isAU = (/^(\+?61|0)[2-9]\d{8}$/.test(digits) || /^04\d{8}$/.test(digits) || /^1[38]00\d{6}$/.test(digits) || /^\+614\d{8}$/.test(digits))
  if (!isAU) return null
  if (digits.startsWith('614') || digits.startsWith('61')) return '+' + digits
  if (digits.length === 10 && digits.startsWith('04')) return digits.replace(/(\d{4})(\d{3})(\d{3})/, '$1 $2 $3')
  if (digits.length === 10 && digits.startsWith('0')) return '(' + digits.slice(0,2) + ') ' + digits.slice(2,6) + ' ' + digits.slice(6)
  if (/^1[38]00/.test(digits)) return digits.replace(/(\d{4})(\d{3})(\d{3})/, '$1 $2 $3')
  return null
}

function scoreAndTier(website) {
  let score = 50, websiteSignal = 'No website'
  if (!website) { score += 40; websiteSignal = 'No website' }
  else {
    const url = website.toLowerCase()
    if (url.includes('facebook') || url.includes('instagram')) { score += 25; websiteSignal = 'Social only' }
    else if (url.includes('wix') || url.includes('squarespace') || url.includes('weebly') || url.includes('wordpress.com')) { score += 15; websiteSignal = 'Basic builder' }
    else { score += 5; websiteSignal = 'Has website' }
  }
  score = Math.min(99, score)
  const tier = score >= 75 ? 'Hot' : score >= 50 ? 'Warm' : 'Cold'
  return { score, websiteSignal, tier }
}

// One shared function so search.js and afk-search.js behave identically.
// maxPages controls how many pages of ~20 results to pull per query — Google
// caps each page at 20 and requires a short delay before requesting the
// next one via pageToken, so more pages = more thorough but slower.
export async function searchPlacesNew(query, location, apiKey, maxPages = 2, stateHint = null) {
  let allPlaces = []
  let pageToken = null
  let pagesFetched = 0
  const { place, state } = parseLocation(location, stateHint)
  const textQuery = state
    ? `${query} in ${place}, ${STATE_NAMES[state]}, Australia`
    : `${query} ${place}, Australia`

  do {
    const requestBody = {
      textQuery,
      regionCode: 'AU',
      languageCode: 'en'
    }
    if (pageToken) requestBody.pageToken = pageToken

    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.businessStatus,places.types,nextPageToken'
      },
      body: JSON.stringify(requestBody)
    })
    const data = await res.json()
    if (data.error) {
      // Only fail the whole search if the very first page errors — a later
      // page failing just means we stop paginating, not that nothing worked.
      if (pagesFetched === 0) {
        return { error: `Google Places error: ${data.error.status || res.status}${data.error.message ? ' — ' + data.error.message : ''}` }
      }
      break
    }
    if (data.places?.length) allPlaces = allPlaces.concat(data.places)
    pageToken = data.nextPageToken || null
    pagesFetched++

    // Google requires a short delay before a pageToken becomes valid
    if (pageToken && pagesFetched < maxPages) await new Promise(r => setTimeout(r, 2000))
  } while (pageToken && pagesFetched < maxPages)

  if (!allPlaces.length) return { leads: [], state, outOfState: 0, blocked: 0 }

  let outOfState = 0
  let blocked = 0

  const leads = allPlaces.map(p => {
    const name = cleanName(p.displayName?.text)
    if (!name) return null
    const address = p.formattedAddress || ''
    if (!isAustralianAddress(address)) return null
    if (state) {
      const found = detectState(address)
      if (found && found !== state) { outOfState++; return null }
    }
    // Emergency services, councils, schools etc. never make it into results
    if (blockReason({ name, types: p.types })) { blocked++; return null }
    const phone = cleanPhone(p.nationalPhoneNumber || p.internationalPhoneNumber)
    const { score, websiteSignal, tier } = scoreAndTier(p.websiteUri)
    return {
      id: p.id, name, phone, website: p.websiteUri || null, address,
      rating: p.rating || null, reviewCount: p.userRatingCount || 0,
      websiteSignal, score, tier, types: p.types || [], email: null, category: query
    }
  }).filter(Boolean)

  // Dedupe within this single query's pages (Google occasionally repeats
  // a result across pages)
  const seen = new Set()
  const deduped = leads.filter(l => (seen.has(l.id) ? false : (seen.add(l.id), true)))

  return { leads: deduped.sort((a, b) => b.score - a.score), state, outOfState, blocked }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { query, location, maxPages, state } = req.body
  const apiKey = process.env.GOOGLE_PLACES_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'Google Places API key not configured' })
  if (!query || !location) return res.status(400).json({ error: 'Category and location required' })

  try {
    const result = await searchPlacesNew(query, location, apiKey, maxPages || 2, state)
    if (result.error) return res.status(200).json({ leads: [], error: result.error })
    return res.status(200).json({ leads: result.leads, state: result.state, outOfState: result.outOfState, blocked: result.blocked || 0 })
  } catch (err) {
    return res.status(500).json({ error: 'Search failed: ' + err.message })
  }
}
