import { cn } from "@/lib/utils"

type MeterTone = "accent" | "success" | "warning" | "danger"

const FILL: Record<MeterTone, string> = {
  accent: "bg-gradient-to-r from-accent-deep to-accent-soft",
  success: "bg-gradient-to-r from-success/70 to-success",
  warning: "bg-gradient-to-r from-warning/70 to-warning",
  danger: "bg-gradient-to-r from-danger/70 to-danger",
}

/**
 * Horizontal magnitude-vs-target meter. One measure, one hue; an optional
 * target tick marks the threshold. Value is always shown as text, so colour is
 * never the sole channel.
 */
export function MeterBar({
  label,
  valueLabel,
  ratio,
  target,
  tone = "accent",
}: {
  label: string
  valueLabel: string
  ratio: number
  target?: number
  tone?: MeterTone
}) {
  const pct = Math.max(2, Math.min(100, ratio * 100))
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs text-muted">{label}</span>
        <span className="num text-xs font-semibold text-fg-dim">{valueLabel}</span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-surface-3">
        <div className={cn("h-full rounded-full transition-[width] duration-700 ease-out", FILL[tone])} style={{ width: `${pct}%` }} />
        {target != null ? (
          <span className="absolute inset-y-0 w-px bg-white/40" style={{ left: `${Math.min(100, target * 100)}%` }} aria-hidden="true" />
        ) : null}
      </div>
    </div>
  )
}

type Segment = { label: string; value: number; color: string }

/**
 * Single stacked bar for part-to-whole (coverage). Segments carry a 2px surface
 * gap and every segment is named in the legend, so identity is label-backed.
 */
export function StackedBar({ segments }: { segments: Segment[] }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0) || 1
  const visible = segments.filter((s) => s.value > 0)
  return (
    <div>
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-surface-3">
        {visible.map((s) => (
          <div
            key={s.label}
            className="h-full rounded-sm transition-[width] duration-700 ease-out first:rounded-l-full last:rounded-r-full"
            style={{ width: `${(s.value / total) * 100}%`, backgroundColor: s.color }}
            title={`${s.label}: ${s.value}`}
          />
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
        {segments.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5 text-xs text-muted">
            <span className="size-2 rounded-sm" style={{ backgroundColor: s.color }} />
            {s.label}
            <span className="num font-semibold text-fg-dim">{s.value}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
