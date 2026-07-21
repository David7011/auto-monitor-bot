"use client"

import { useEffect, useRef } from "react"
import { useEffectTier } from "@/lib/perf"

type Node = { x: number; y: number; vx: number; vy: number; r: number; a: number }

const ACCENT = "242, 106, 31"
const AMBER = "245, 166, 35"

/**
 * Ambient control-center backdrop: a slow drifting particle field with faint
 * connection lines, rendered on a single fixed canvas behind the whole app.
 *
 * Performance guards:
 *  - tier "off"  → nothing renders (the body ambient gradient stays).
 *  - tier "lite" → static CSS grid only, no canvas loop.
 *  - device pixel ratio capped at 1.5; particle count scales with area.
 *  - the RAF loop is time-based (~40fps target) and pauses on hidden tabs.
 */
export function LiveBackground() {
  const tier = useEffectTier()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (tier !== "full") return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d", { alpha: true })
    if (!ctx) return

    let width = 0
    let height = 0
    let nodes: Node[] = []
    let raf = 0
    let last = 0
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    const linkDist = 128

    const build = () => {
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const target = Math.min(74, Math.round((width * height) / 26000))
      nodes = Array.from({ length: target }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.16,
        vy: (Math.random() - 0.5) * 0.16,
        r: Math.random() * 1.6 + 0.6,
        a: Math.random() * 0.5 + 0.25,
      }))
    }

    const step = (t: number) => {
      raf = requestAnimationFrame(step)
      if (t - last < 24) return // ~40fps ceiling
      last = t

      ctx.clearRect(0, 0, width, height)

      for (const n of nodes) {
        n.x += n.vx
        n.y += n.vy
        if (n.x < -20) n.x = width + 20
        if (n.x > width + 20) n.x = -20
        if (n.y < -20) n.y = height + 20
        if (n.y > height + 20) n.y = -20
      }

      // Connection lines — the "data mesh" between sources
      const linkDistSq = linkDist * linkDist
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]
          const b = nodes[j]
          const dx = a.x - b.x
          const dy = a.y - b.y
          // Reject far pairs on the squared distance so the sqrt only runs for
          // the few pairs that actually get a line drawn.
          const distSq = dx * dx + dy * dy
          if (distSq > linkDistSq) continue
          const dist = Math.sqrt(distSq)
          const alpha = (1 - dist / linkDist) * 0.16
          ctx.strokeStyle = `rgba(${ACCENT}, ${alpha})`
          ctx.lineWidth = 0.6
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
      }

      for (const n of nodes) {
        ctx.fillStyle = `rgba(${n.r > 1.4 ? AMBER : ACCENT}, ${n.a})`
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf)
        raf = 0
      } else if (!raf) {
        last = 0
        raf = requestAnimationFrame(step)
      }
    }

    let resizeTimer = 0
    const onResize = () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(build, 200)
    }

    build()
    raf = requestAnimationFrame(step)
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("resize", onResize, { passive: true })

    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(resizeTimer)
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("resize", onResize)
    }
  }, [tier])

  if (tier === "off") return null

  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <div className="grid-overlay absolute inset-0 opacity-70" />
      {tier === "full" ? (
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full opacity-80" />
      ) : null}
      {/* Sinking vignette so content floats above real depth */}
      <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_0%,transparent_40%,rgba(6,7,9,0.6)_100%)]" />
    </div>
  )
}
