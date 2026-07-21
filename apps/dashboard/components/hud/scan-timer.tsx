"use client"

import { useEffect, useMemo, useState } from "react"

function format(ms: number) {
  if (ms <= 0) return "00:00"
  const total = Math.ceil(ms / 1000)
  const min = Math.floor(total / 60)
  const sec = total % 60
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
}

export function ScanTimer({ nextTickAt }: { nextTickAt: string | null }) {
  const target = useMemo(() => (nextTickAt ? new Date(nextTickAt).getTime() : null), [nextTickAt])
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  return <span className="font-mono">{target ? format(target - now) : "--:--"}</span>
}
