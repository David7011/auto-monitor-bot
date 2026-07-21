import { cn } from "@/lib/utils"

type Tone = "success" | "warning" | "danger" | "accent" | "muted"

const DOT: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  accent: "bg-accent",
  muted: "bg-muted",
}

const RING: Record<Tone, string> = {
  success: "bg-success/60",
  warning: "bg-warning/60",
  danger: "bg-danger/60",
  accent: "bg-accent/60",
  muted: "bg-muted/40",
}

/** A pulsing status dot with an expanding ping ring when live. */
export function LiveDot({ tone = "accent", live = true, className }: { tone?: Tone; live?: boolean; className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2.5 items-center justify-center", className)} aria-hidden="true">
      {live ? (
        <span
          className={cn("absolute inline-flex size-full rounded-full", RING[tone])}
          style={{ animation: "ping-ring 2s cubic-bezier(0,0,0.2,1) infinite" }}
        />
      ) : null}
      <span className={cn("relative inline-flex size-1.5 rounded-full", DOT[tone], live && "animate-pulse-glow")} />
    </span>
  )
}
