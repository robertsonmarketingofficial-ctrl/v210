import { useState, useEffect } from 'react'

export function Spinner({ size = 16 }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />
}

export function Modal({ title, onClose, children, width = 640 }) {
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal" style={{ maxWidth: width }} onMouseDown={e => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal-head"><div className="panel-title">{title}</div><button className="x" onClick={onClose} aria-label="Close">×</button></div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

export function Drawer({ title, onClose, children, actions }) {
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <>
      <div className="drawer-back" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={title}>
        <div className="modal-head"><div className="panel-title">{title}</div><div className="row">{actions}<button className="x" onClick={onClose} aria-label="Close">×</button></div></div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  )
}

let toastFn = null
export function toast(msg) { toastFn?.(msg) }
export function ToastHost() {
  const [msg, setMsg] = useState('')
  useEffect(() => {
    let t
    toastFn = (m) => { setMsg(m); clearTimeout(t); t = setTimeout(() => setMsg(''), 2600) }
    return () => { toastFn = null }
  }, [])
  return msg ? <div className="toast" role="status">{msg}</div> : null
}

export function Empty({ title, sub, children }) {
  return <div className="empty"><div className="empty-t">{title}</div><div>{sub}</div>{children && <div style={{ marginTop: 16 }}>{children}</div>}</div>
}

export function Stat({ value, label, sub, tone }) {
  return (
    <div className="panel stat">
      <div className={`stat-v ${tone || ''}`}>{value}</div>
      <div className="stat-l">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

export function Field({ label, children, hint }) {
  return (
    <label style={{ display: 'block' }}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="small muted" style={{ display: 'block', marginTop: 5 }}>{hint}</span>}
    </label>
  )
}

export function PageIntro({ title, children }) {
  return <><h1 className="h1">{title}</h1>{children && <p className="lede">{children}</p>}</>
}

export const fmtWhen = (d) => {
  if (!d) return ''
  const t = new Date(d)
  const diff = Date.now() - t.getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  if (diff < 7 * 86400000) return t.toLocaleDateString('en-AU', { weekday: 'short' })
  return t.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
}

export const fmtIn = (ms) => {
  const s = Math.max(0, Math.round((ms - Date.now()) / 1000))
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${s}s`
}

export function downloadFile(name, content, type = 'application/json') {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([content], { type }))
  a.download = name
  a.click()
}

export function toCSV(rows, headers) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  return [headers.map(h => esc(h.label)).join(','), ...rows.map(r => headers.map(h => esc(typeof h.get === 'function' ? h.get(r) : r[h.key])).join(','))].join('\n')
}

export const CATEGORIES = ['Plumber', 'Electrician', 'Roofer', 'Landscaper', 'Builder', 'Concreter', 'Painter', 'Tiler', 'Fencing contractor', 'Carpenter', 'Air conditioning installer', 'Solar installer', 'Pest control', 'Cleaning service', 'Pool builder', 'Locksmith', 'Garage door installer', 'Plasterer', 'Bricklayer', 'Glazier', 'Arborist', 'Excavation contractor', 'Mechanic', 'Removalist']

// Bounce-check result for an email
export function CheckTag({ status, reason, suggestion }) {
  if (!status) return null
  if (status === 'valid') return <span className="tag ok" title={reason}>Deliverable</span>
  if (status === 'invalid') return <span className="tag bad" title={`${reason || ''}${suggestion ? ` Did you mean ${suggestion}?` : ''}`}>Would bounce</span>
  return <span className="tag" title={reason}>Unchecked</span>
}

// useState that survives switching tabs and refreshing (saved per form)
export function usePersisted(formKey, key, initial) {
  const read = () => { try { return JSON.parse(localStorage.getItem(formKey) || '{}') || {} } catch { return {} } }
  const [v, setV] = useState(() => { const f = read(); return key in f ? f[key] : initial })
  const set = (x) => setV(prev => {
    const next = typeof x === 'function' ? x(prev) : x
    try { localStorage.setItem(formKey, JSON.stringify({ ...read(), [key]: next })) } catch {}
    return next
  })
  return [v, set]
}
