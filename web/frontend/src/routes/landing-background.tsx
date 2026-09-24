import { useEffect, useRef } from 'react'

type Particle = { x: number; y: number; vx: number; vy: number; r: number; tone: number }

const TONES = [
  { r: 154, g: 235, b: 210 }, // mint
  { r: 138, g: 180, b: 236 }, // blue
  { r: 196, g: 181, b: 253 }, // violet
  { r: 246, g: 200, b: 137 }, // amber
]

/**
 * Fixed full-viewport backdrop for the landing page:
 * drifting aurora orbs + a particle constellation that reacts to the cursor.
 * Honors the page-level pause toggle and prefers-reduced-motion.
 */
export function LandingBackground({ paused }: { paused: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const spotRef = useRef<HTMLDivElement>(null)

  // Cursor spotlight (fine pointers only — handled in CSS for coarse ones).
  useEffect(() => {
    if (paused) return
    const media = window.matchMedia('(hover: hover) and (pointer: fine)')
    if (!media.matches) return
    const spot = spotRef.current
    if (!spot) return
    let frame = 0
    let targetX = window.innerWidth / 2
    let targetY = window.innerHeight * 0.35
    let x = targetX
    let y = targetY
    let active = false
    const move = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return
      targetX = event.clientX
      targetY = event.clientY
      if (!active) {
        active = true
        spot.style.opacity = '1'
        x = targetX
        y = targetY
      }
    }
    const tick = () => {
      x += (targetX - x) * 0.09
      y += (targetY - y) * 0.09
      spot.style.transform = `translate3d(${x - 340}px, ${y - 340}px, 0)`
      frame = requestAnimationFrame(tick)
    }
    window.addEventListener('pointermove', move, { passive: true })
    frame = requestAnimationFrame(tick)
    return () => {
      window.removeEventListener('pointermove', move)
      cancelAnimationFrame(frame)
      spot.style.opacity = '0'
    }
  }, [paused])

  // Particle constellation canvas.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches
    const ctx = context
    let width = 0
    let height = 0
    let dpr = 1
    let particles: Particle[] = []
    let frame = 0
    let running = false
    let last = performance.now()
    const pointer = { x: -9999, y: -9999, active: false }

    const countFor = (area: number) => Math.max(30, Math.min(95, Math.round(area / 17000)))

    const seed = () => {
      const total = countFor(width * height)
      particles = Array.from({ length: total }, () => {
        const tone = Math.floor(Math.random() * TONES.length)
        return {
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.22,
          vy: (Math.random() - 0.5) * 0.22,
          r: 0.7 + Math.random() * 1.3,
          tone,
        }
      })
    }

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 1.75)
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      seed()
      draw()
    }

    const draw = () => {
      ctx.clearRect(0, 0, width, height)

      // constellation lines
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i]!
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j]!
          const dx = a.x - b.x
          const dy = a.y - b.y
          const distance = Math.hypot(dx, dy)
          if (distance > 118) continue
          const alpha = (1 - distance / 118) * 0.13
          ctx.strokeStyle = `rgba(154, 235, 210, ${alpha.toFixed(3)})`
          ctx.lineWidth = 0.7
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
      }

      // cursor links
      if (pointer.active && fine) {
        for (const p of particles) {
          const distance = Math.hypot(p.x - pointer.x, p.y - pointer.y)
          if (distance > 170) continue
          const alpha = (1 - distance / 170) * 0.3
          ctx.strokeStyle = `rgba(154, 235, 210, ${alpha.toFixed(3)})`
          ctx.lineWidth = 0.8
          ctx.beginPath()
          ctx.moveTo(pointer.x, pointer.y)
          ctx.lineTo(p.x, p.y)
          ctx.stroke()
        }
      }

      // particles
      for (const p of particles) {
        const tone = TONES[p.tone]!
        const near = pointer.active && fine && Math.hypot(p.x - pointer.x, p.y - pointer.y) < 170
        ctx.fillStyle = `rgba(${tone.r}, ${tone.g}, ${tone.b}, ${near ? 0.85 : 0.42})`
        ctx.beginPath()
        ctx.arc(p.x, p.y, near ? p.r + 0.5 : p.r, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    const step = (now: number) => {
      if (!running) return
      const delta = Math.min((now - last) / 16.7, 3)
      last = now
      for (const p of particles) {
        if (pointer.active && fine) {
          const dx = pointer.x - p.x
          const dy = pointer.y - p.y
          const distance = Math.hypot(dx, dy)
          if (distance < 170 && distance > 1) {
            const force = (1 - distance / 170) * 0.014
            p.vx += (dx / distance) * force
            p.vy += (dy / distance) * force
          }
        }
        p.vx *= 0.992
        p.vy *= 0.992
        const speed = Math.hypot(p.vx, p.vy)
        if (speed > 0.55) {
          p.vx = (p.vx / speed) * 0.55
          p.vy = (p.vy / speed) * 0.55
        }
        p.x += p.vx * delta
        p.y += p.vy * delta
        if (p.x < -12) p.x = width + 12
        else if (p.x > width + 12) p.x = -12
        if (p.y < -12) p.y = height + 12
        else if (p.y > height + 12) p.y = -12
      }
      draw()
      frame = requestAnimationFrame(step)
    }

    const start = () => {
      if (running || paused || reduce || document.hidden) return
      running = true
      last = performance.now()
      frame = requestAnimationFrame(step)
    }
    const stop = () => {
      running = false
      cancelAnimationFrame(frame)
    }

    const onPointer = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return
      pointer.x = event.clientX
      pointer.y = event.clientY
      pointer.active = true
    }
    const onLeave = () => {
      pointer.active = false
      pointer.x = -9999
      pointer.y = -9999
    }
    const onVisibility = () => (document.hidden ? stop() : start())

    resize()
    window.addEventListener('resize', resize)
    window.addEventListener('pointermove', onPointer, { passive: true })
    window.addEventListener('pointerleave', onLeave)
    document.addEventListener('visibilitychange', onVisibility)
    if (paused || reduce) draw()
    else start()

    return () => {
      stop()
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onPointer)
      window.removeEventListener('pointerleave', onLeave)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [paused])

  return (
    <div className="terra-bg" aria-hidden="true" data-paused={paused}>
      <div className="terra-bg-aurora">
        <span className="terra-orb terra-orb-a" />
        <span className="terra-orb terra-orb-b" />
        <span className="terra-orb terra-orb-c" />
        <span className="terra-orb terra-orb-d" />
      </div>
      <canvas ref={canvasRef} className="terra-bg-canvas" />
      <div ref={spotRef} className="terra-bg-spot" />
      <div className="terra-bg-noise" />
    </div>
  )
}
