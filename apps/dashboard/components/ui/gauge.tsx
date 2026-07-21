import { cn } from "@/lib/utils"

type GaugeProps = {
  value: number
  size?: number
  label?: string
  sublabel?: string
  className?: string
}

function toneFor(value: number): string {
  if (value >= 75) return "var(--c-success)"
  if (value >= 45) return "var(--c-amber)"
  return "var(--c-danger)"
}

/** Radial progress gauge (0–100). Used for source health and readiness. */
export function Gauge({ value, size = 96, label, sublabel, className }: GaugeProps) {
  const clamped = Math.max(0, Math.min(100, value))
  const stroke = 7
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const dash = (clamped / 100) * circumference
  const color = toneFor(clamped)

  return (
    <div className={cn("relative shrink-0", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--c-line)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          style={{
            transition: "stroke-dasharray 0.9s cubic-bezier(0.22,1,0.36,1), stroke 0.4s ease",
            filter: `drop-shadow(0 0 6px color-mix(in srgb, ${color} 55%, transparent))`,
          }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="num text-xl font-semibold text-foreground">{label ?? Math.round(clamped)}</span>
        {sublabel ? <span className="text-[10px] tracking-widest text-muted uppercase">{sublabel}</span> : null}
      </div>
    </div>
  )
}
