// Client-side fetch helper. When a Vercel function times out or crashes it
// returns an HTML error page, and `await r.json()` throws a cryptic
// "Unexpected token '<'" — which is what used to show up as the send error.
// This always resolves to an object with a readable `error` on failure.

export async function apiJSON(url, { method = 'GET', body, timeoutMs = 65000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    const text = await r.text()
    let data = null
    try { data = text ? JSON.parse(text) : {} } catch {}
    if (data && typeof data === 'object') {
      if (!r.ok && !data.error) data.error = `Server error ${r.status}`
      return data
    }
    if (r.status === 504 || /FUNCTION_INVOCATION_TIMEOUT/i.test(text)) {
      return { status: 'failed', error: 'Server timed out (Vercel 60s limit) — Gmail did not respond in time. Will be retried.' }
    }
    return { status: 'failed', error: `Server error ${r.status}: ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'empty response'}` }
  } catch (err) {
    return {
      status: 'failed',
      error: err.name === 'AbortError' ? 'Request timed out — no response from the server.' : `Network error: ${err.message}`,
    }
  } finally {
    clearTimeout(timer)
  }
}
