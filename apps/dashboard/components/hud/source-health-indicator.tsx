import { StatusBadge } from "./status-badge"
import { LiveDot } from "@/components/ui/live-dot"
import type { SourceRow } from "@/lib/types"

function dotTone(status: SourceRow["status"]): "success" | "warning" | "danger" | "muted" {
  if (status === "ACTIVE") return "success"
  if (["LIMITED", "PAUSED", "RATE_LIMITED"].includes(status)) return "warning"
  if (["ERROR", "CAPTCHA_DETECTED"].includes(status)) return "danger"
  return "muted"
}

export function SourceHealthIndicator({ source }: { source: SourceRow }) {
  const newestOk = source.supportsNewestFirst && source.newestFirstVerified
  return (
    <div className="surface-card flex items-center justify-between gap-3 rounded-xl px-3.5 py-3 transition-colors hover:border-line-strong">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <LiveDot tone={dotTone(source.status)} live={source.enabled && source.status === "ACTIVE"} />
          <span className="truncate text-sm font-semibold text-foreground">{source.name}</span>
        </div>
        <div className="num mt-1 font-mono text-[11px] text-muted">
          {source.enabled ? `${source.intervalSeconds}s · здоровье ${source.healthScore ?? 0}%` : "выключен"}
        </div>
        <div className={newestOk ? "mt-1 font-mono text-[10px] text-success" : "mt-1 font-mono text-[10px] text-warning"}>
          {newestOk ? "СНАЧАЛА НОВЫЕ" : "ЛОКАЛЬНАЯ СОРТИРОВКА"}
        </div>
      </div>
      <StatusBadge status={source.status} />
    </div>
  )
}
