"use client"

import { useState } from "react"
import useSWR from "swr"
import { Power, RadioTower, ShieldAlert, Zap } from "lucide-react"
import { clientApi as api, dashboardErrorMessage } from "@/lib/client-api"
import type { BulkSourceActionResponse, ChallengeIncidentRow, CollectorRunRow, SourceKind, SourceRow } from "@/lib/types"
import { HudPanel } from "@/components/hud/hud-panel"
import { GlowButton } from "@/components/hud/glow-button"
import { StatusBadge } from "@/components/hud/status-badge"
import { SourceCard } from "@/components/sources/source-card"
import { DataTable, type Column } from "@/components/ui/data-table"
import { useToast } from "@/components/ui/toast"
import { formatDateTime, sourceLabel } from "@/lib/format"

const fetcher = <T,>(path: string) => api.get<T>(path)

type SourcesStatus = {
  sources: SourceRow[]
  recentRuns: CollectorRunRow[]
  challengeIncidents: ChallengeIncidentRow[]
}

export default function SourcesPage() {
  const [busyId, setBusyId] = useState<string | null>(null)
  const { toast } = useToast()
  const { data, mutate } = useSWR<SourcesStatus>("/sources/status", fetcher, { refreshInterval: 4000 })
  const sources = data?.sources ?? []
  const activeRealSources = sources.filter((s) => ["OLX", "RST", "CARS_UA", "AUTOMOTO", "AUTO_RIA"].includes(s.source) && s.enabled && ["ACTIVE", "LIMITED"].includes(s.status)).length

  const foundBySource = new Map<SourceKind, number>()
  for (const run of data?.recentRuns ?? []) {
    foundBySource.set(run.source, (foundBySource.get(run.source) ?? 0) + run.foundCount)
  }

  async function command(key: string, fn: () => Promise<{ tone?: "success" | "info" | "warning"; title: string; description?: string }>) {
    setBusyId(key)
    try {
      const result = await fn()
      await mutate()
      toast({ tone: result.tone ?? "success", title: result.title, description: result.description })
    } catch (err) {
      toast({ tone: "error", title: "Команда не выполнена", description: dashboardErrorMessage(err) })
    } finally {
      setBusyId(null)
    }
  }

  const checkNow = (source: SourceRow) => command(source.id, async () => {
    await api.post(`/sources/${source.id}/check-now`)
    return { tone: "info", title: `В очередь: ${source.name}` }
  })
  const toggle = (source: SourceRow) => command(source.id, async () => {
    await api.patch(`/sources/${source.id}`, { enabled: !source.enabled })
    return { title: `${source.enabled ? "Выключен" : "Включён"} источник ${source.name}` }
  })
  const checkActive = () => command("bulk", async () => {
    const result = await api.post<BulkSourceActionResponse>("/sources/check-active")
    return { tone: result.count ? "info" : "warning", title: result.count ? `В очередь добавлено: ${result.count}` : "Нет активных источников" }
  })
  const enableReal = () => command("bulk", async () => {
    const result = await api.post<BulkSourceActionResponse>("/sources/real/enable")
    return { title: `Включено источников: ${result.updated ?? 0}` }
  })
  const disableReal = () => command("bulk", async () => {
    const result = await api.post<BulkSourceActionResponse>("/sources/real/disable")
    return { tone: "warning", title: `Выключено источников: ${result.updated ?? 0}` }
  })

  const incidentColumns: Column<ChallengeIncidentRow>[] = [
    { key: "time", header: "Время", render: (r) => <span className="num text-xs text-muted">{formatDateTime(r.detectedAt)}</span> },
    { key: "source", header: "Источник", render: (r) => <span className="font-medium text-fg-dim">{r.source?.name ?? r.sourceId}</span> },
    { key: "status", header: "Статус", render: (r) => <StatusBadge status={r.status} /> },
    { key: "detector", header: "Детектор", render: (r) => <span className="font-mono text-xs text-muted">{r.detector}</span> },
    { key: "http", header: "HTTP", align: "right", render: (r) => <span className="num text-xs">{r.responseStatus ?? "—"}</span> },
    { key: "cooldown", header: "Пауза до", align: "right", render: (r) => <span className="num text-xs text-muted">{formatDateTime(r.cooldownUntil)}</span> },
  ]

  const runColumns: Column<CollectorRunRow>[] = [
    { key: "time", header: "Время", render: (r) => <span className="num text-xs text-muted">{formatDateTime(r.startedAt)}</span> },
    { key: "source", header: "Источник", render: (r) => <span className="font-medium text-fg-dim">{sourceLabel(r.source)}</span> },
    { key: "lane", header: "Контур", render: (r) => <span className="font-mono text-[11px] text-muted">{r.lane}</span> },
    { key: "status", header: "Статус", render: (r) => <StatusBadge status={r.status} /> },
    { key: "found", header: "Найдено", align: "right", render: (r) => <span className="num">{r.foundCount}</span> },
    { key: "new", header: "Новых", align: "right", render: (r) => <span className="num text-accent-soft">{r.newCount}</span> },
    { key: "error", header: "Ошибка", render: (r) => <span className="line-clamp-1 text-xs text-danger">{r.errorMessage ?? "—"}</span> },
  ]

  return (
    <div className="space-y-6 py-2">
      <header className="relative overflow-hidden rounded-2xl glass edge-light px-5 py-6 sm:px-7">
        <div className="pointer-events-none absolute -top-20 -right-10 size-56 rounded-full bg-accent/10 blur-3xl" />
        <div className="relative flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <RadioTower className="size-4 text-accent-soft" />
              <span className="kicker">Центр источников</span>
            </div>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl"><span className="text-gradient">Источники</span></h1>
            <p className="mt-2 max-w-2xl text-sm text-muted">
              Каждый источник работает автономно. При 403/429/CAPTCHA источник уходит на паузу, создаётся инцидент, остальные продолжают эфир.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:w-auto">
            <GlowButton className="w-full" loading={busyId === "bulk"} onClick={checkActive}><Zap /> Проверить активные</GlowButton>
            <GlowButton className="w-full" tone="success" loading={busyId === "bulk"} onClick={enableReal}><Power /> Включить все</GlowButton>
            <GlowButton className="w-full" tone="danger" loading={busyId === "bulk"} onClick={disableReal}>Выключить все</GlowButton>
          </div>
        </div>
        <div className="relative mt-4 inline-flex items-center gap-2 rounded-lg border border-line bg-surface-1/60 px-3 py-1.5 text-sm">
          <span className="size-1.5 animate-pulse-glow rounded-full bg-success" />
          <span className="text-muted">В эфире:</span>
          <span className="num font-semibold text-foreground">{activeRealSources}</span>
        </div>
      </header>

      <div className="grid gap-4 xl:grid-cols-2">
        {sources.map((source) => (
          <SourceCard
            key={source.id}
            source={source}
            foundToday={foundBySource.get(source.source) ?? 0}
            busy={busyId === source.id}
            onCheck={() => checkNow(source)}
            onToggle={() => toggle(source)}
          />
        ))}
        {sources.length === 0 ? <div className="text-sm text-muted">Загрузка источников…</div> : null}
      </div>

      <HudPanel kicker="Защита" title="Инциденты источников" action={<ShieldAlert className="size-4 text-accent-soft" />} noPadding>
        <div className="p-4 sm:p-5">
          <DataTable
            columns={incidentColumns}
            rows={data?.challengeIncidents ?? []}
            getKey={(r) => r.id}
            minWidth={760}
            empty="Инцидентов нет — источники не упирались в CAPTCHA, 403 или 429."
          />
        </div>
      </HudPanel>

      <HudPanel kicker="История" title="Последние проверки" noPadding>
        <div className="p-4 sm:p-5">
          <DataTable
            columns={runColumns}
            rows={data?.recentRuns ?? []}
            getKey={(r) => r.id}
            minWidth={740}
            empty="Пока нет свежих запусков источников."
          />
        </div>
      </HudPanel>
    </div>
  )
}
