"use client"

import type React from "react"
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

type GlowButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "accent" | "danger" | "success" | "neutral"
  loading?: boolean
}

const TONES = {
  accent:
    "border-accent/40 bg-gradient-to-b from-accent/20 to-accent/8 text-accent-soft hover:from-accent/28 hover:to-accent/14 hover:border-accent/60 shadow-[0_0_18px_-4px_rgba(242,106,31,0.4)]",
  success:
    "border-success/40 bg-gradient-to-b from-success/18 to-success/6 text-success hover:from-success/26 hover:border-success/60 shadow-[0_0_18px_-4px_rgba(52,206,127,0.32)]",
  danger:
    "border-danger/40 bg-gradient-to-b from-danger/18 to-danger/6 text-danger hover:from-danger/26 hover:border-danger/60 shadow-[0_0_18px_-4px_rgba(242,89,74,0.32)]",
  neutral:
    "border-line-strong bg-surface-3 text-fg-dim hover:bg-surface-4 hover:text-foreground",
}

/**
 * Primary action control. Glass-tinted, with a spring-like press (active:scale)
 * and an inline loading state. Backward compatible with the tone-only API.
 */
export function GlowButton({ tone = "accent", loading, className, disabled, children, ...props }: GlowButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl border px-5 text-sm font-semibold tracking-wide",
        "transition-all duration-200 ease-out outline-none select-none",
        "hover:-translate-y-px active:translate-y-0 active:scale-[0.97]",
        "focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-0",
        "disabled:pointer-events-none disabled:opacity-45 disabled:saturate-50 [&_svg]:size-4",
        TONES[tone],
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 className="animate-spin" /> : null}
      {children}
    </button>
  )
}
