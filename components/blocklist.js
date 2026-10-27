// Stops the CRM finding or emailing things that aren't businesses you can sell
// to: emergency services, councils, government, schools, hospitals, churches,
// clubs and charities. Used by the lead search (server) and the send engine
// (browser), so anything already in the pipeline is caught before it's emailed.

const NAME_PATTERNS = [
  [/\bSES\b/, 'emergency service'],
  [/state emergency|emergency services?\b/i, 'emergency service'],
  [/\b(CFS|MFS|CFA|RFS|QFES|DFES)\b|country fire|rural fire|fire (and|&) rescue|fire (station|brigade|service|authority)/i, 'fire service'],
  [/\bpolice\b|\bambulance\b|\bparamedic/i, 'emergency service'],
  [/\bcouncil\b|\bcity of\b|\btown of\b|\bshire\b|\bmunicipal|\bregional council/i, 'council'],
  [/\bgovernment\b|\bgovt\b|\bdepartment of\b|\bdept\.? of\b|\bparliament\b|\bministry\b|\bservice ?sa\b|\bservice ?nsw\b|\bservices australia\b/i, 'government'],
  [/\bhospital\b|\bhealth (service|network)\b|\bmedical cent(re|er)\b/i, 'health service'],
  [/\bschool\b|\bcollege\b|\buniversity\b|\btafe\b|\bkindergarten\b|\bkindy\b|\bchild ?care\b|\bearly learning\b/i, 'school'],
  [/\blibrary\b|\bmuseum\b|\bcemetery\b|\bbotanic|\bnational park\b|\bconservation park\b|\bzoo\b/i, 'public place'],
  [/\bchurch\b|\bparish\b|\bmosque\b|\bsynagogue\b|\bcathedral\b|\bministries\b/i, 'church'],
  [/\bRSL\b|\bscouts?\b|\bgirl guides\b|\brotary\b|\blions club\b|\bmen'?s shed\b|\blandcare\b|\bvolunteer|\bcommunity (cent(re|er)|garden|hall)\b|\bcharity\b/i, 'club or charity'],
  [/\bprison\b|\bcorrectional\b|\bcourt ?house\b|\bmagistrates\b|\bdefence\b|\barmy\b|\bnavy\b|\bRAAF\b/i, 'government'],
  [/\bsa water\b|\bsydney water\b|\bwater corporation\b|\bpower networks?\b|\bsa power\b|\bausgrid\b|\benergex\b|\bergon\b|\bwestern power\b/i, 'utility'],
]

const BLOCKED_TYPES = {
  local_government_office: 'council', city_hall: 'council', government_office: 'government',
  courthouse: 'government', embassy: 'government', police: 'emergency service', fire_station: 'fire service',
  hospital: 'health service', school: 'school', primary_school: 'school', secondary_school: 'school',
  university: 'school', preschool: 'school', library: 'public place', museum: 'public place',
  church: 'church', place_of_worship: 'church', mosque: 'church', synagogue: 'church', hindu_temple: 'church',
  post_office: 'government', cemetery: 'public place', national_park: 'public place',
}

const DOMAIN_PATTERNS = [
  [/\.gov(\.[a-z]{2})?$/i, 'government email'],
  [/\.edu(\.[a-z]{2})?$/i, 'school email'],
  [/\.mil(\.[a-z]{2})?$/i, 'government email'],
  [/(^|\.)police\.|(^|\.)health\.[a-z]+\.gov/i, 'government email'],
]

function domainOf(email) {
  return String(email || '').toLowerCase().split('@')[1] || ''
}

// Settings → "Never email": comma or new-line separated words, business
// names, email addresses or domains (e.g. "bunnings, @example.com.au")
export function parseExtra(text) {
  return String(text || '').split(/[\n,]+/).map(x => x.trim().toLowerCase()).filter(Boolean)
}

// Returns a short reason if this lead should never be emailed, otherwise null.
export function blockReason(lead, extra = [], { builtIn = true } = {}) {
  if (!lead) return null
  const name = String(lead.name || '')
  const email = String(lead.email || '').toLowerCase()
  const domain = domainOf(email)
  if (builtIn) {
    for (const [re, why] of NAME_PATTERNS) if (re.test(name)) return why
    for (const t of lead.types || []) if (BLOCKED_TYPES[t]) return BLOCKED_TYPES[t]
    if (domain) for (const [re, why] of DOMAIN_PATTERNS) if (re.test(domain)) return why
  }
  const lname = name.toLowerCase()
  for (const x of extra) {
    if (x.includes('@')) {
      const d = x.replace(/^@/, '')
      if (email === x || domain === d || domain.endsWith('.' + d)) return 'on your Never email list'
    } else if (x.includes('.') && !x.includes(' ')) {
      if (domain === x || domain.endsWith('.' + x)) return 'on your Never email list'
    } else if (lname.includes(x)) return 'on your Never email list'
  }
  return null
}
