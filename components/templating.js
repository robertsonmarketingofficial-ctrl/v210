// Fills email templates for a lead.
//   Tokens:  {{name}} {{category}} {{suburb}} {{state}} {{rating}} {{reviewCount}} {{sender}}
//   Spintax: {Hey|Hi|G'day} picks one at random per email, so 210 emails a
//            day aren't 210 identical copies (identical copy is a spam signal).

export const TOKENS = ['name', 'category', 'suburb', 'state', 'rating', 'reviewCount', 'sender']

const STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']
export const STATE_TZ = {
  SA: 'Australia/Adelaide', NT: 'Australia/Darwin', WA: 'Australia/Perth', QLD: 'Australia/Brisbane',
  NSW: 'Australia/Sydney', ACT: 'Australia/Sydney', VIC: 'Australia/Melbourne', TAS: 'Australia/Hobart',
}

// Uses the LAST state code in the address ("12 SA Water Rd, Perth WA 6000"
// is WA, not SA), falling back to the postcode.
export function leadState(lead) {
  const a = String(lead?.address || '').toUpperCase()
  const hits = [...a.matchAll(/\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b(?=\s*\d{3,4}|\s*,|\s*$)/g)]
  if (hits.length) return hits[hits.length - 1][1]
  const pc = a.match(/\b(\d{4})\b(?!.*\b\d{4}\b)/)
  if (pc) {
    const n = Number(pc[1])
    if ((n >= 2600 && n <= 2618) || (n >= 2900 && n <= 2920)) return 'ACT'
    if (n >= 2000 && n <= 2999) return 'NSW'
    if (n >= 3000 && n <= 3999) return 'VIC'
    if (n >= 4000 && n <= 4999) return 'QLD'
    if (n >= 5000 && n <= 5999) return 'SA'
    if (n >= 6000 && n <= 6999) return 'WA'
    if (n >= 7000 && n <= 7999) return 'TAS'
    if (n >= 800 && n <= 999) return 'NT'
  }
  return STATES.find(s => new RegExp(`\\b${s}\\b`).test(a)) || null
}

export function leadSuburb(lead) {
  const parts = String(lead?.address || '').split(',').map(s => s.trim())
  const withState = parts.find(p => STATES.some(s => new RegExp(`\\b${s}\\b\\s*\\d{0,4}$`).test(p.toUpperCase())))
  if (withState) return withState.replace(/\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b.*$/i, '').trim()
  return parts.length >= 3 ? parts[parts.length - 2].replace(/\d{4}$/, '').trim() : ''
}

// "Smith's Plumbing Pty Ltd" → "Smith's Plumbing"
export function cleanBusinessName(name = '') {
  return String(name)
    .replace(/\s*\b(pty\.?\s*ltd\.?|pty|ltd\.?|limited|p\/l)\b\.?/gi, '')
    .replace(/\s*[-|–—]\s*(adelaide|melbourne|sydney|brisbane|perth|hobart|darwin|canberra).*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function spin(text = '') {
  let out = String(text)
  // Resolve innermost {a|b} groups first; {{tokens}} have no pipe so are left alone
  const re = /\{([^{}]*\|[^{}]*)\}/
  let guard = 0
  while (re.test(out) && guard++ < 200) {
    out = out.replace(re, (_, inner) => {
      const opts = inner.split('|')
      return opts[Math.floor(Math.random() * opts.length)]
    })
  }
  return out
}

export function render(text, lead = {}, ctx = {}) {
  const values = {
    name: cleanBusinessName(lead.name) || 'there',
    category: String(lead.category || 'business').toLowerCase(),
    suburb: leadSuburb(lead) || 'your area',
    state: leadState(lead) || '',
    rating: lead.rating ? String(lead.rating) : '',
    reviewCount: lead.reviewCount ? String(lead.reviewCount) : '',
    sender: String(ctx.fromName || 'Callum').split(' ')[0],
  }
  const filled = String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in values ? values[k] : m))
  return spin(filled).replace(/[ \t]+\n/g, '\n').trim()
}

// Is it currently inside the sending window where the LEAD is?
export function inWindow(settings, lead, now = new Date()) {
  const tz = (settings.leadLocalTime && STATE_TZ[leadState(lead)]) || 'Australia/Adelaide'
  return inWindowTz(settings, tz, now)
}

// Hours left in today's sending window (Adelaide time), for spreading sends.
export function windowMsLeft(settings, tz = 'Australia/Adelaide', now = new Date()) {
  if (settings.anyTime) return 86400000
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now)
  const h = Number(parts.find(p => p.type === 'hour')?.value) % 24
  const m = Number(parts.find(p => p.type === 'minute')?.value) || 0
  const nowMin = h * 60 + m
  const start = Number(settings.windowStart) * 60, end = Number(settings.windowEnd) * 60
  let left = start <= end ? end - nowMin : (nowMin >= start ? 1440 - nowMin + end : end - nowMin)
  return Math.max(0, left) * 60000
}

export function inWindowTz(settings, tz = 'Australia/Adelaide', now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', hour12: false, weekday: 'short' }).formatToParts(now)
  const hour = Number(parts.find(p => p.type === 'hour')?.value) % 24
  const wd = parts.find(p => p.type === 'weekday')?.value
  if (settings.weekdaysOnly && (wd === 'Sat' || wd === 'Sun')) return false
  if (settings.anyTime) return true
  const start = Number(settings.windowStart), end = Number(settings.windowEnd)
  // Overnight windows (e.g. 6pm to 2am) wrap past midnight
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end
}
