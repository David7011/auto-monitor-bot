"use client"

import { animate } from "framer-motion"
import { useEffect, useRef, useState } from "react"

type AnimatedNumberProps = {
  value: number
  duration?: number
  decimals?: number
  format?: (n: number) => string
  className?: string
}

/**
 * Tweens a number toward its latest value with an ease-out curve, so KPIs feel
 * alive without re-mounting. Falls back to an instant jump if the delta is tiny.
 */
export function AnimatedNumber({ value, duration = 0.8, decimals = 0, format, className }: AnimatedNumberProps) {
  const [display, setDisplay] = useState(value)
  const prev = useRef(value)

  useEffect(() => {
    const from = prev.current
    prev.current = value
    if (Math.abs(value - from) < 0.5 && decimals === 0) {
      setDisplay(value)
      return
    }
    const controls = animate(from, value, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (latest) => setDisplay(latest),
    })
    return () => controls.stop()
  }, [value, duration, decimals])

  const rounded = decimals > 0 ? display.toFixed(decimals) : Math.round(display).toString()
  return <span className={className}>{format ? format(Number(rounded)) : rounded}</span>
}
