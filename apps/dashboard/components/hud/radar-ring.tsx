import { cn } from "@/lib/utils"

/**
 * Radar disc for the monitoring core. Concentric rings, a sweeping accent
 * gradient, crosshair ticks and a pulsing centre when active.
 */
export function RadarRing({ active, className, size = 112 }: { active: boolean; className?: string; size?: number }) {
  return (
    <div className={cn("relative shrink-0", className)} style={{ width: size, height: size }} aria-hidden="true">
      <div className="absolute inset-0 rounded-full border border-line" />
      <div className="absolute inset-[14%] rounded-full border border-line/70" />
      <div className="absolute inset-[30%] rounded-full border border-line/50" />
      <div className="absolute inset-[46%] rounded-full border border-line/40" />

      {/* crosshair */}
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line/50" />
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line/50" />

      <div
        className={cn("absolute inset-0 rounded-full", active ? "animate-radar-sweep" : "opacity-25")}
        style={{
          background:
            "conic-gradient(from 0deg, rgba(242,106,31,0.55) 0deg, rgba(242,106,31,0.12) 46deg, transparent 92deg)",
          maskImage: "radial-gradient(circle, black 62%, transparent 63%)",
          WebkitMaskImage: "radial-gradient(circle, black 62%, transparent 63%)",
        }}
      />

      {active ? (
        <span
          className="absolute top-1/2 left-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/50"
          style={{ animation: "ping-ring 2.4s cubic-bezier(0,0,0.2,1) infinite" }}
        />
      ) : null}
      <div
        className={cn(
          "absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full",
          active ? "bg-accent shadow-[0_0_12px_rgba(242,106,31,0.9)] animate-pulse-glow" : "bg-muted",
        )}
      />
    </div>
  )
}
