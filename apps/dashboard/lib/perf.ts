"use client"

import { useEffect, useState } from "react"

export type EffectTier = "full" | "lite" | "off"

/**
 * Decides how heavy the visual effects (animated background, ambient motion)
 * are allowed to be, based on the device. Heavy scenes are downgraded on weak
 * hardware and disabled entirely when the user prefers reduced motion.
 *
 * SSR-safe: renders "lite" until mounted so the first paint never assumes a
 * capability the device may not have.
 */
export function useEffectTier(): EffectTier {
  const [tier, setTier] = useState<EffectTier>("lite")

  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)")

    const resolve = (): EffectTier => {
      if (reduceMotion.matches) return "off"

      const cores = navigator.hardwareConcurrency ?? 8
      const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8
      const coarse = window.matchMedia("(pointer: coarse)").matches
      const narrow = window.innerWidth < 720

      // Phones and low-core laptops keep the ambient gradient but drop the
      // canvas particle field to protect the monitoring tool's responsiveness.
      if (cores <= 4 || memory <= 4) return "lite"
      if (coarse && narrow) return "lite"
      return "full"
    }

    setTier(resolve())
    const onChange = () => setTier(resolve())
    reduceMotion.addEventListener("change", onChange)
    window.addEventListener("resize", onChange, { passive: true })
    return () => {
      reduceMotion.removeEventListener("change", onChange)
      window.removeEventListener("resize", onChange)
    }
  }, [])

  return tier
}

/** True once mounted on the client — for gating client-only visuals. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return mounted
}
