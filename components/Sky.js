import { useEffect, useRef } from 'react'

// Background: 'storm' = soft rain, rolling lightning, the odd shooting star.
//             'stars' = still night sky with shooting stars.
//             'off'   = plain black.
// Pauses when the tab is hidden; respects reduced-motion.
export default function Sky({ mode = 'storm' }) {
  const canvasRef = useRef(null)
  const flashRef = useRef(null)

  useEffect(() => {
    if (mode === 'off') return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let w = 0, h = 0, dpr = 1, raf = 0
    let stars = [], drops = [], meteors = [], bolt = null
    let nextBolt = performance.now() + 4000 + Math.random() * 8000
    let nextMeteor = performance.now() + 3000 + Math.random() * 6000

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = window.innerWidth; h = window.innerHeight
      canvas.width = w * dpr; canvas.height = h * dpr
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const n = Math.round((w * h) / (mode === 'stars' ? 5200 : 9000))
      stars = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h * (mode === 'storm' ? 0.55 : 1), r: Math.random() * 1.1 + 0.2, a: Math.random() * 0.5 + 0.15, tw: Math.random() * Math.PI * 2 }))
      drops = mode === 'storm' ? Array.from({ length: Math.round(w / 9) }, () => newDrop(true)) : []
    }
    const newDrop = (anywhere) => ({ x: Math.random() * (w + 200) - 100, y: anywhere ? Math.random() * h : -20, len: 10 + Math.random() * 18, v: 9 + Math.random() * 7, a: 0.05 + Math.random() * 0.09 })

    const makeBolt = () => {
      const pts = []
      let x = w * (0.15 + Math.random() * 0.7), y = 0
      const end = h * (0.35 + Math.random() * 0.35)
      while (y < end) { pts.push([x, y]); x += (Math.random() - 0.5) * 60; y += 12 + Math.random() * 26 }
      const branches = []
      for (let i = 2; i < pts.length - 2; i += 3) {
        if (Math.random() < 0.45) {
          let [bx, by] = pts[i]; const b = [[bx, by]]
          const dir = Math.random() < 0.5 ? -1 : 1
          for (let k = 0; k < 4 + Math.random() * 4; k++) { bx += dir * (8 + Math.random() * 22); by += 10 + Math.random() * 18; b.push([bx, by]) }
          branches.push(b)
        }
      }
      return { pts, branches, born: performance.now(), x: pts[0][0] }
    }

    const strokePath = (pts, width, alpha) => {
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1])
      for (const p of pts) ctx.lineTo(p[0], p[1])
      ctx.strokeStyle = `rgba(205,225,255,${alpha})`; ctx.lineWidth = width; ctx.stroke()
    }

    const draw = (t) => {
      ctx.clearRect(0, 0, w, h)
      // stars
      for (const s of stars) {
        const a = reduce ? s.a : s.a * (0.7 + 0.3 * Math.sin(t / 1400 + s.tw))
        ctx.fillStyle = `rgba(220,230,255,${a})`
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill()
      }
      if (!reduce) {
        // rain
        ctx.lineWidth = 1
        for (const d of drops) {
          ctx.strokeStyle = `rgba(170,195,235,${d.a})`
          ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - d.len * 0.18, d.y + d.len); ctx.stroke()
          d.y += d.v; d.x -= d.v * 0.18
          if (d.y > h) Object.assign(d, newDrop(false))
        }
        // lightning
        if (mode === 'storm' && t > nextBolt) {
          bolt = makeBolt()
          nextBolt = t + 9000 + Math.random() * 16000
          const f = flashRef.current
          if (f) { f.style.setProperty('--fx', `${(bolt.x / w) * 100}%`); f.classList.remove('on'); void f.offsetWidth; f.classList.add('on') }
        }
        if (bolt) {
          const age = t - bolt.born
          const life = 650
          if (age > life) bolt = null
          else {
            const flick = age < 90 ? 1 : age < 160 ? 0.25 : age < 260 ? 0.85 : Math.max(0, 1 - (age - 260) / (life - 260))
            ctx.shadowColor = 'rgba(160,200,255,0.9)'; ctx.shadowBlur = 18
            strokePath(bolt.pts, 2.2, 0.9 * flick)
            for (const b of bolt.branches) strokePath(b, 1, 0.5 * flick)
            ctx.shadowBlur = 0
          }
        }
        // shooting stars
        if (t > nextMeteor) {
          const fromLeft = Math.random() < 0.5
          meteors.push({ x: fromLeft ? Math.random() * w * 0.5 : w * 0.5 + Math.random() * w * 0.5, y: Math.random() * h * 0.3, vx: (fromLeft ? 1 : -1) * (7 + Math.random() * 5), vy: 2.5 + Math.random() * 2.5, life: 0 })
          nextMeteor = t + (mode === 'stars' ? 5000 + Math.random() * 9000 : 14000 + Math.random() * 20000)
        }
        meteors = meteors.filter(m => m.life < 70)
        for (const m of meteors) {
          m.x += m.vx; m.y += m.vy; m.life++
          const a = Math.sin((m.life / 70) * Math.PI)
          const g = ctx.createLinearGradient(m.x, m.y, m.x - m.vx * 14, m.y - m.vy * 14)
          g.addColorStop(0, `rgba(235,242,255,${a})`); g.addColorStop(1, 'rgba(235,242,255,0)')
          ctx.strokeStyle = g; ctx.lineWidth = 1.6
          ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x - m.vx * 14, m.y - m.vy * 14); ctx.stroke()
        }
      }
      raf = requestAnimationFrame(draw)
    }

    resize()
    window.addEventListener('resize', resize)
    raf = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize) }
  }, [mode])

  if (mode === 'off') return null
  return (
    <>
      <canvas ref={canvasRef} className="sky" style={{ background: mode === 'storm' ? 'radial-gradient(ellipse at 50% -20%, #0b1220 0%, #000 60%)' : 'radial-gradient(ellipse at 50% 120%, #070b16 0%, #000 65%)' }} />
      <div ref={flashRef} className="flash" />
    </>
  )
}
