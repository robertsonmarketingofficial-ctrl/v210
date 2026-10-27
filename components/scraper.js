// Server-side only — finds a business email on its own website.
// mailto links first, then obfuscated addresses, then contact/about pages.

export async function scrapeEmail(website) {
  if (!website) return null
  let parsed
  try {
    parsed = new URL(website)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
  } catch { return null }

  // Social-only pages can't be scraped for a contact address this way.
  const host = parsed.hostname.toLowerCase()
  if (['facebook.com','www.facebook.com','instagram.com','www.instagram.com','linkedin.com','www.linkedin.com','tiktok.com','youtube.com']
      .some(h => host === h || host.endsWith('.' + h))) return null

  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g

  const isJunk = (e) => {
    const l = e.toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return true
    const junk = ['noreply','no-reply','donotreply','do-not-reply','example.','test@','sentry.','wixpress.',
      'schema.org','w3.org','wordpress.','shopify.','squarespace.','cloudflare.','godaddy.','.png','.jpg','.jpeg',
      '.gif','.svg','.webp','.js','.css','@2x','sentry-next','yourdomain','domain.com','email.com','user@']
    return junk.some(j => l.includes(j))
  }

  // Prefer the business's own address. Emails on someone else's domain are
  // usually the web designer's ("site by bob@webdesign.com.au") and get a big
  // penalty, while free mail (gmail, bigpond...) is common for tradies and fine.
  const siteDomain = host.replace(/^www\./, '')
  const FREE = /@(gmail|outlook|hotmail|live|yahoo|icloud|me|bigpond|optusnet|iinet|internode|tpg|westnet|adam|aapt|dodo)\./
  const rank = (e) => {
    const l = e.toLowerCase()
    const d = l.split('@')[1] || ''
    let r = 2
    if (/^(info|enquiries|enquiry|contact|admin|office|hello|sales|bookings|quotes|jobs|service)@/.test(l)) r = 0
    else if (/^(accounts|support|mail|reception)@/.test(l)) r = 1
    else if (/(webmaster|postmaster|hostmaster|abuse|privacy|careers|hr|marketing|media)@/.test(l)) r = 3
    const sameSite = d === siteDomain || d.endsWith('.' + siteDomain) || siteDomain.endsWith('.' + d)
    if (!sameSite && !FREE.test(l)) r += 5
    return r
  }
  const tidy = (e) => decodeURIComponent(String(e)).replace(/%40/gi, '@').trim().replace(/^[<("'\s]+|[>)"'\s.,;:]+$/g, '').toLowerCase()

  const extract = (html) => {
    const found = new Set()

    // mailto: links are the most reliable signal — check them first.
    for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
      let e = ''
      try { e = tidy(m[1]) } catch { continue }
      if (e && !isJunk(e)) found.add(e)
    }

    // Decode common HTML entity obfuscation (&#64; / &commat; for @)
    const decoded = html
      .replace(/&#0*64;|&#x0*40;|&commat;/gi, '@')
      .replace(/&#0*46;|&#x0*2e;|&period;/gi, '.')

    for (const raw of (decoded.match(emailRegex) || [])) {
      const e = tidy(raw)
      if (!isJunk(e)) found.add(e)
    }

    // Text obfuscation: "info [at] example [dot] com" / "info (at) example.com"
    for (const m of decoded.matchAll(/([a-zA-Z0-9._%+\-]+)\s*[\[\(]\s*(?:at|@)\s*[\]\)]\s*([a-zA-Z0-9.\-]+)\s*(?:[\[\(]\s*(?:dot|\.)\s*[\]\)]\s*([a-zA-Z]{2,}))?/gi)) {
      const e = m[3] ? `${m[1]}@${m[2]}.${m[3]}` : `${m[1]}@${m[2]}`
      if (!isJunk(e)) found.add(e.toLowerCase())
    }

    // Government addresses on a page (e.g. a council link) are never the business
    return Array.from(found).filter(e => !/\.gov(\.au)?$|\.edu(\.au)?$/.test(e))
  }

  const fetchPage = async (url, timeoutMs = 10000) => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const r = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-AU,en;q=0.9',
        },
      })
      clearTimeout(t)
      if (!r.ok) return ''
      return await r.text()
    } catch { clearTimeout(t); return '' }
  }

  const best = (emails) => emails.length ? [...new Set(emails)].sort((a, b) => rank(a) - rank(b))[0] : null
  const good = (emails) => emails.some(e => rank(e) < 5)

  // 1. Homepage
  const homeHtml = await fetchPage(website)
  const fromHome = extract(homeHtml)
  if (good(fromHome)) return best(fromHome)

  // 2. Follow contact-ish links actually present on the homepage, rather than
  //    only guessing at fixed paths.
  const linked = new Set()
  if (homeHtml) {
    for (const m of homeHtml.matchAll(/href=["']([^"']+)["']/gi)) {
      const href = m[1]
      if (/contact|about|enquir|quote|get-in-touch|reach-us/i.test(href)) {
        try { linked.add(new URL(href, parsed.origin).href) } catch {}
      }
      if (linked.size >= 5) break
    }
  }

  const guesses = ['/contact', '/contact-us', '/contact.html', '/contact-us.html', '/about',
                   '/about-us', '/get-a-quote', '/enquiry', '/contacts']
    .map(p => `${parsed.origin}${p}`)

  // Check discovered links first, then common guesses — in parallel batches
  // so one slow page doesn't stall everything.
  const candidates = [...linked, ...guesses].slice(0, 10)
  for (let i = 0; i < candidates.length; i += 4) {
    const batch = candidates.slice(i, i + 4)
    const pages = await Promise.all(batch.map(u => fetchPage(u, 8000)))
    const emails = pages.flatMap(extract)
    if (good(emails)) return best(emails)
  }

  // Only someone else's address found (probably the web designer): skip it
  // rather than pitching the wrong business.
  return null
}
