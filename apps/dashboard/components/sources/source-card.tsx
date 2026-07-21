"use client"

import type React from "react"
import { Activity, Clock, Gauge as GaugeIcon, Power, RefreshCw, Timer, TriangleAlert } from "lucide-react"
import type { SourceKind, SourceRow } from "@/lib/types"
import { GlowButton } from "@/components/hud/glow-button"
import { StatusBadge } from "@/components/hud/status-badge"
import { Gauge } from "@/components/ui/gauge"
import { LiveDot } from "@/components/ui/live-dot"
import { formatMs, formatRelative, sourceLabel } from "@/lib/format"
import { cn } from "@/lib/utils"

const BRAND: Record<SourceKind, { tint: string; text: string }> = {
  OLX: { tint: "from-accent/25 to-accent/5 border-accent/40", text: "text-accent-soft" },
  AUTO_RIA: { tint: "from-success/20 to-success/5 border-success/35", text: "text-success" },
  RST: { tint: "from-amber/20 to-amber/5 border-amber/35", text: "text-amber-soft" },
  CARS_UA: { tint: "from-accent/18 to-accent/4 border-accent/30", text: "text-accent-soft" },
  AUTOMOTO: { tint: "from-warning/18 to-warning/4 border-warning/30", text: "text-warning" },
  MOCK: { tint: "from-surface-4 to-surface-2 border-line-strong", text: "text-muted" },
}

function dotTone(status: SourceRow["status"]): "success" | "warning" | "danger" | "muted" {
  if (["ACTIVE"].includes(status)) return "success"
  if (["LIMITED", "PAUSED", "RATE_LIMITED"].includes(status)) return "warning"
  if (["ERROR", "CAPTCHA_DETECTED"].includes(status)) return "danger"
  return "muted"
}

export function SourceCard({
  source,
  foundToday,
  onCheck,
  onToggle,
  busy,
}: {
  source: SourceRow
  foundToday: number
  onCheck: () => void
  onToggle: () => void
  busy?: boolean
}) {
  const brand = BRAND[source.source] ?? BRAND.MOCK
  const monogram = sourceLabel(source.source).slice(0, 2).toUpperCase()
  const newestOk = source.supportsNewestFirst && source.newestFirstVerified
  const live = source.enabled && source.status === "ACTIVE"

  return (
    <div className="surface-card group relative overflow-hidden rounded-2xl p-4 transition-all duration-300 hover:border-line-strong hover:shadow-[var(--shadow-2)] sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className={cn("flex size-12 shrink-0 items-center justify-center rounded-xl border bg-gradient-to-b font-bold", brand.tint, brand.text)}>
            {monogram}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-base font-semibold text-foreground">{source.name}</h3>
              <LiveDot tone={dotTone(source.status)} live={live} />
            </div>
            <div className="mt-0.5 font-mono text-[11px] text-muted">
              {source.capabilities?.accessMode ?? "PUBLIC_HTTP"} · {source.intervalSeconds}s
            </div>
          </div>
        </div>
        <StatusBadge status={source.status} />
      </div>

      <div className="mt-4 flex items-center gap-4">
        <Gauge value={source.enabled ? source.healthScore : 0} size={78} sublabel="здоровье" />
        <div className="grid flex-1 grid-cols-2 gap-x-3 gap-y-2.5">
          <Stat icon={<Timer className="size-3.5" />} label="Отклик" value={formatMs(source.lastDurationMs)} />
          <Stat icon={<Activity className="size-3.5" />} label="Найдено" value={String(foundToday)} />
          <Stat icon={<Clock className="size-3.5" />} label="Проверка" value={formatRelative(source.lastCheckedAt)} />
          <Stat icon={<GaugeIcon className="size-3.5" />} label="Порядок" value={newestOk ? "новые" : "локально"} tone={newestOk ? "success" : "warning"} />
        </div>
      </div>

      {source.consecutiveEmptyResults > 0 ? (
        <div className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-[11px] text-warning">
          <TriangleAlert className="size-3" /> Пустых ответов подряд: {source.consecutiveEmptyResults}
        </div>
      ) : null}

      {source.lastError ? (
        <div className="mt-3 line-clamp-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" title={source.lastError}>
          {source.lastError}
        </div>
      ) : null}

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <GlowButton className="w-full" tone="neutral" loading={busy} onClick={onCheck}><RefreshCw /> Проверить</GlowButton>
        <GlowButton className="w-full" tone={source.enabled ? "danger" : "success"} loading={busy} onClick={onToggle}>
          <Power /> {source.enabled ? "Выключить" : "Включить"}
        </GlowButton>
      </div>
    </div>
  )
}

function Stat({ icon, label, value, tone = "default" }: { icon: React.ReactNode; label: string; value: string; tone?: "default" | "success" | "warning" }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[10px] tracking-widest text-muted uppercase [&_svg]:text-faint">{icon}{label}</div>
      <div className={cn("num mt-0.5 truncate text-sm font-semibold", tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "text-fg-dim")}>{value}</div>
    </div>
  )
}
