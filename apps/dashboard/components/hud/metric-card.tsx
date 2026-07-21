import type React from "react"
import { cn } from "@/lib/utils"

type Tone = "default" | "accent" | "success" | "warning" | "danger"

type MetricCardProps = {
  label: string
  value: React.ReactNode
  icon?: React.ReactNode
  hint?: React.ReactNode
  tone?: Tone
  live?: boolean
  footer?: React.ReactNode
  className?: string
}

const ICON_TONE: Record<Tone, string> = {
  default: "border-line-strong bg-surface-3 text-accent-soft",
  accent: "border-accent/40 bg-accent/12 text-accent-soft",
  success: "border-success/35 bg-success/10 text-success",
  warning: "border-warning/35 bg-warning/10 text-warning",
  danger: "border-danger/35 bg-danger/10 text-danger",
}

const GLOW: Record<Tone, string> = {
  default: "",
  accent: "before:bg-accent/70",
  success: "before:bg-success/70",
  warning: "before:bg-warning/70",
  danger: "before:bg-danger/70",
}

/**
 * KPI tile: label, big animated-friendly value, icon chip, and an optional
 * footer slot (sparkline / delta). A left accent bar signals tone/state.
 */
export function MetricCard({ label, value, icon, hint, tone = "default", live, footer, className }: MetricCardProps) {
  return (
    <div
      className={cn(
        "surface-card group relative overflow-hidden rounded-xl p-4 transition-all duration-300",
        "hover:-translate-y-0.5 hover:border-line-strong hover:shadow-[var(--shadow-2)]",
        "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-['']",
        tone === "default" ? "before:bg-line-strong" : GLOW[tone],
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[11px] font-medium tracking-widest text-muted uppercase">{label}</span>
            {live ? <span className="size-1.5 animate-pulse-glow rounded-full bg-success" /> : null}
          </div>
          <div className="num mt-1.5 text-2xl leading-none font-semibold text-foreground">{value}</div>
          {hint ? <div className="mt-1.5 text-xs text-muted">{hint}</div> : null}
        </div>
        {icon ? (
          <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg border [&_svg]:size-[18px]", ICON_TONE[tone])}>
            {icon}
          </div>
        ) : null}
      </div>
      {footer ? <div className="mt-3">{footer}</div> : null}
    </div>
  )
}
