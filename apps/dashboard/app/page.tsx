"use client"

import type React from "react"
import { useState } from "react"
import useSWR from "swr"
import {
  Activity,
  AlertTriangle,
  Bell,
  Car,
  Clock,
  DatabaseZap,
  Gauge as GaugeIcon,
  ListFilter,
  Power,
  RadioTower,
  RotateCw,
  Send,
  ShieldCheck,
  Zap,
} from "lucide-react"
import { clientApi as api, dashboardErrorMessage } from "@/lib/client-api"
import type { BulkSourceActionResponse, ListingRow, MetricsResponse, MonitoringStatusResponse, SourceKind, SystemCheckResponse } from "@/lib/types"
import { GlowButton } from "@/components/hud/glow-button"
import { HudPanel } from "@/components/hud/hud-panel"
import { MetricCard } from "@/components/hud/metric-card"
import { RadarRing } from "@/components/hud/radar-ring"
import { StatusBadge } from "@/components/hud/status-badge"
import { ScanTimer } from "@/components/hud/scan-timer"
import { SourceHealthIndicator } from "@/components/hud/source-health-indicator"
import { Gauge } from "@/components/ui/gauge"
import { AnimatedNumber } from "@/components/ui/animated-number"
import { MeterBar, StackedBar } from "@/components/ui/meter"
import { LiveDot } from "@/components/ui/live-dot"
import { LiveFeed } from "@/components/feed/live-feed"
import { useToast } from "@/components/ui/toast"
import { formatDateTime, formatMs } from "@/lib/format"

const fetcher = <T,>(path: string) => api.get<T>(path)
const REAL_SOURCES = new Set<SourceKind>(["AUTO_RIA", "OLX", "RST", "CARS_UA", "AUTOMOTO"])

export default function DashboardPage() {
  const [pending, setPending] = useState<string | null>(null)
  const { toast } = useToast()

  const { data, mutate, error: statusError } = useSWR<MonitoringStatusResponse>("/monitoring/status", fetcher, { refreshInterval: 3000 })
  const { data: systemCheck, mutate: mutateSystemCheck } = useSWR<SystemCheckResponse>("/system/check", fetcher, { refreshInterval: 8000 })
  const { data: listingData, isLoading: listingsLoading } = useSWR<{ listings: ListingRow[] }>("/listings/recent?limit=9", fetcher, { refreshInterval: 5000 })
  const { data: metrics } = useSWR<MetricsResponse>("/metrics", fetcher, { refreshInterval: 10000 })

  const running = data?.state.status === "RUNNING"
  const liveMode = running && data?.mode === "LIVE"
  const activeSources = data?.sources.filter((s) => REAL_SOURCES.has(s.source) && s.enabled && ["ACTIVE", "LIMITED"].includes(s.status)).length ?? 0
  const totalRealSources = data?.sources.filter((s) => REAL_SOURCES.has(s.source)).length ?? 0
  const queueLoad = data?.queues ? Object.values(data.queues).reduce((sum, q) => sum + q.waiting + q.active, 0) : 0
  const failedJobs = data?.queues ? Object.values(data.queues).reduce((sum, q) => sum + q.failed, 0) : 0
  const activeRealFilters = data?.filters.activeReal ?? 0
  const backendError = statusError ? dashboardErrorMessage(statusError) : null

  const readiness =
    (running ? 35 : 0) +
    (activeSources > 0 ? 25 : 0) +
    (activeRealFilters > 0 ? 25 : 0) +
    (data?.telegramConfigured ? 10 : 0) +
    (failedJobs === 0 ? 5 : 0)
  const battleReady = readiness >= 100

  async function run(key: string, fn: () => Promise<void>) {
    setPending(key)
    try {
      await fn()
      await Promise.all([mutate(), mutateSystemCheck()])
    } catch (err) {
      toast({ tone: "error", title: "Команда не выполнена", description: dashboardErrorMessage(err) })
    } finally {
      setPending(null)
    }
  }

  const start = () => run("start", async () => {
    await api.post("/monitoring/start")
    toast({ tone: "success", title: "Мониторинг запущен" })
  })
  const startLive = () => run("live", async () => {
    await api.post("/monitoring/live/start")
    toast({ tone: "success", title: "LIVE-режим активирован", description: "Быстрый контур сканирует источники в реальном времени." })
  })
  const stop = () => run("stop", async () => {
    await api.post("/monitoring/stop")
    toast({ tone: "warning", title: "Мониторинг остановлен" })
  })
  const scanNow = () => run("scan", async () => {
    const result = await api.post<BulkSourceActionResponse>("/sources/check-active")
    toast({ tone: result.count ? "info" : "warning", title: result.count ? `В очередь добавлено источников: ${result.count}` : "Нет активных источников" })
  })
  const enableRealSources = () => run("enable", async () => {
    const result = await api.post<BulkSourceActionResponse>("/sources/real/enable")
    toast({ tone: "success", title: `Включено источников: ${result.updated ?? 0}` })
  })

  const coverage = metrics?.coverageToday
  const detectMs = metrics?.publicationToDetectionMs.p95 ?? null
  const telegramMs = metrics?.detectionToTelegramMs.p95 ?? null

  return (
    <div className="space-y-6 py-2">
      {/* Hero */}
      <header className="relative overflow-hidden rounded-2xl glass edge-light px-5 py-6 sm:px-7 sm:py-7">
        <div className="pointer-events-none absolute -top-24 -right-16 size-64 rounded-full bg-accent/10 blur-3xl" />
        <div className="relative flex flex-col justify-between gap-5 xl:flex-row xl:items-center">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2">
              <LiveDot tone={liveMode ? "accent" : running ? "success" : "muted"} live={running} />
              <span className="kicker">{liveMode ? "LIVE · Радар активен" : running ? "Мониторинг активен" : "Система в ожидании"}</span>
            </div>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
              <span className="text-gradient">Центр мониторинга</span>
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted">
              Живой контроль автомобильного рынка. Ссылка уходит в Telegram мгновенно, проверка VIN и оценка рынка идут фоном и дополняют то же сообщение.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            <GlowButton className="h-11 sm:h-10" loading={pending === "scan"} onClick={scanNow}><Zap /> Сканировать</GlowButton>
            <GlowButton className="h-11 sm:h-10" tone="accent" loading={pending === "live"} disabled={liveMode} onClick={startLive}><RadioTower /> LIVE</GlowButton>
            <GlowButton className="h-11 sm:h-10" tone="success" loading={pending === "start"} disabled={running} onClick={start}>Старт</GlowButton>
            <GlowButton className="h-11 sm:h-10" tone="danger" loading={pending === "stop"} disabled={!running} onClick={stop}>Стоп</GlowButton>
          </div>
        </div>
      </header>

      {backendError ? (
        <HudPanel className="border-warning/40 !bg-warning/10">
          <div className="kicker text-warning">Backend недоступен</div>
          <div className="mt-1 text-sm text-foreground">{backendError}</div>
        </HudPanel>
      ) : null}

      {/* Readiness + KPIs */}
      <section className="grid gap-4 xl:grid-cols-[320px_1fr]">
        <HudPanel kicker="Боевая готовность" title="Статус ядра" action={battleReady ? <ShieldCheck className="size-4 text-success" /> : <AlertTriangle className="size-4 text-warning" />}>
          <div className="flex items-center gap-5">
            <Gauge value={readiness} label={`${readiness}%`} sublabel="готово" />
            <div className="min-w-0 flex-1 space-y-2">
              <Readiness ok={running} label="Ядро мониторинга" />
              <Readiness ok={activeSources > 0} label={`Источники · ${activeSources}/${totalRealSources}`} />
              <Readiness ok={activeRealFilters > 0} label={`Боевые фильтры · ${activeRealFilters}`} />
              <Readiness ok={Boolean(data?.telegramConfigured)} label="Telegram" />
              <Readiness ok={failedJobs === 0} label={failedJobs ? `Сбои очередей · ${failedJobs}` : "Очереди чистые"} />
            </div>
          </div>
        </HudPanel>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <MetricCard
            label="Состояние"
            tone={running ? "success" : "default"}
            live={running}
            value={<StatusBadge status={data?.state.status ?? "STOPPED"} />}
            icon={<Activity />}
            hint={liveMode ? "LIVE-режим" : running ? "стандартный режим" : "остановлен"}
          />
          <MetricCard
            label="След. проверка"
            tone="accent"
            value={<ScanTimer nextTickAt={data?.state.nextTickAt ?? null} />}
            icon={<Clock />}
            hint={liveMode ? "live-пульс" : "по расписанию"}
          />
          <MetricCard
            label="Найдено сегодня"
            tone="accent"
            value={<AnimatedNumber value={data?.foundToday ?? 0} />}
            icon={<Car />}
            hint={`восстановлено: ${coverage?.recovered ?? 0}`}
          />
          <MetricCard
            label="Активные фильтры"
            value={<AnimatedNumber value={activeRealFilters} />}
            icon={<ListFilter />}
            hint={`всего: ${data?.filters.total ?? 0}`}
          />
          <MetricCard
            label="Источники"
            tone={activeSources > 0 ? "success" : "warning"}
            value={<><AnimatedNumber value={activeSources} /><span className="text-lg text-muted">/{totalRealSources}</span></>}
            icon={<RadioTower />}
            hint="активных в эфире"
          />
          <MetricCard
            label="Очередь"
            tone={failedJobs > 0 ? "danger" : "default"}
            value={<AnimatedNumber value={queueLoad} />}
            icon={<DatabaseZap />}
            hint={failedJobs ? `сбоев: ${failedJobs}` : "ожидают + идут"}
          />
        </div>
      </section>

      {/* Alerts */}
      {data && activeRealFilters === 0 ? (
        <ActionBanner
          tone="danger"
          title="Нет боевого фильтра"
          text="Мониторинг сканирует источники, но Telegram не отправит находки без включённого фильтра для боевых источников."
          action={<a className="text-sm font-semibold text-accent-soft hover:underline" href="/filters">Открыть фильтры →</a>}
        />
      ) : null}
      {data && running && activeSources === 0 ? (
        <ActionBanner
          tone="danger"
          title="Источники выключены"
          text="Мониторинг запущен, но все реальные источники выключены — новых проверок не будет."
          action={<GlowButton loading={pending === "enable"} onClick={enableRealSources}><Power /> Включить источники</GlowButton>}
        />
      ) : null}

      {/* Speed + coverage */}
      <section className="grid gap-4 lg:grid-cols-2">
        <HudPanel kicker="Скорость контура" title="Задержки LIVE, p95" action={<GaugeIcon className="size-4 text-accent-soft" />}>
          <div className="space-y-4">
            <MeterBar
              label="Публикация → обнаружение"
              valueLabel={formatMs(detectMs)}
              ratio={ratioAgainst(detectMs, 10 * 60 * 1000)}
              target={0.5}
              tone={toneForLatency(detectMs, 10 * 60 * 1000)}
            />
            <MeterBar
              label="Обнаружение → Telegram"
              valueLabel={formatMs(telegramMs)}
              ratio={ratioAgainst(telegramMs, 30 * 1000)}
              target={0.5}
              tone={toneForLatency(telegramMs, 30 * 1000)}
            />
            <MeterBar
              label="Длительность сбора"
              valueLabel={formatMs(metrics?.collectorDurationMs.p95 ?? null)}
              ratio={ratioAgainst(metrics?.collectorDurationMs.p95 ?? null, 15 * 1000)}
              target={0.5}
              tone={toneForLatency(metrics?.collectorDurationMs.p95 ?? null, 15 * 1000)}
            />
            <div className="grid grid-cols-3 gap-2 border-t border-line pt-3 text-center">
              <MiniStat label="Отправок" value={metrics?.sampleSize.telegramNotifications ?? 0} />
              <MiniStat label="Прогонов" value={metrics?.sampleSize.collectorRuns ?? 0} />
              <MiniStat label="Ждут TG" value={coverage?.telegramPending ?? 0} tone={coverage?.telegramPending ? "warning" : "default"} />
            </div>
          </div>
        </HudPanel>

        <HudPanel kicker="Покрытие сегодня" title="Как находим объявления" action={<Activity className="size-4 text-accent-soft" />}>
          <div className="space-y-4">
            <StackedBar
              segments={[
                { label: "Сразу (LIVE)", value: coverage?.realtime ?? 0, color: "var(--c-accent)" },
                { label: "Восстановлено", value: coverage?.recovered ?? 0, color: "var(--c-amber-soft)" },
                { label: "Вручную", value: coverage?.manual ?? 0, color: "var(--c-faint)" },
              ]}
            />
            <div className="space-y-2 border-t border-line pt-3">
              <div className="kicker mb-1">Проходы по контурам</div>
              {(() => {
                const lanes = metrics?.laneRunsToday ?? []
                const laneMax = Math.max(1, ...lanes.map((l) => l.found))
                return lanes.map((lane) => <LaneRow key={lane.lane} lane={lane} max={laneMax} />)
              })()}
              {!metrics?.laneRunsToday?.length ? <div className="text-xs text-muted">Пока нет прогонов сегодня.</div> : null}
            </div>
          </div>
        </HudPanel>
      </section>

      {/* Core + sources health */}
      <section className="grid gap-4 xl:grid-cols-[360px_1fr]">
        <HudPanel kicker="Радар" title="Ядро мониторинга">
          <div className="flex items-center gap-5">
            <RadarRing active={running} />
            <div className="min-w-0 space-y-2.5">
              <StatusBadge status={data?.state.status ?? "STOPPED"} />
              <InfoLine label="Источников в эфире" value={String(activeSources)} />
              <InfoLine label="Telegram" value={data?.telegramConfigured ? "настроен" : "не настроен"} />
              <InfoLine label="Последний тик" value={formatDateTime(data?.state.lastTickAt)} />
            </div>
          </div>
        </HudPanel>

        <HudPanel kicker="Источники" title="Здоровье источников" action={<RadioTower className="size-4 text-accent-soft" />}>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {(data?.sources ?? []).map((source) => <SourceHealthIndicator key={source.id} source={source} />)}
            {!data?.sources?.length ? <div className="text-sm text-muted">Загрузка источников…</div> : null}
          </div>
        </HudPanel>
      </section>

      {/* System check + queues */}
      <section className="grid gap-4 xl:grid-cols-[1fr_1.4fr]">
        <HudPanel kicker="Диагностика" title="Проверка системы" action={<RotateCw className="size-4 text-accent-soft" />}>
          <div className="space-y-2">
            {(systemCheck?.checks ?? []).map((check) => (
              <div key={check.name} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-1/50 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground">{check.name}</div>
                  <div className="truncate text-xs text-muted">{check.message}</div>
                </div>
                <StatusBadge status={check.status} />
              </div>
            ))}
            {!systemCheck?.checks?.length ? <div className="text-sm text-muted">Загрузка диагностики…</div> : null}
          </div>
        </HudPanel>

        <HudPanel kicker="Очереди" title="Нагрузка пайплайна" action={<Send className="size-4 text-accent-soft" />}>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {Object.entries(data?.queues ?? {}).map(([name, queue]) => (
              <div key={name} className="rounded-lg border border-line bg-surface-1/50 p-3">
                <div className="truncate font-mono text-[11px] text-accent-soft">{name}</div>
                <div className="mt-2 grid grid-cols-3 gap-1 text-center text-xs">
                  <QueueCell value={queue.waiting} label="ждёт" />
                  <QueueCell value={queue.active} label="идёт" />
                  <QueueCell value={queue.failed} label="сбой" danger={queue.failed > 0} />
                </div>
              </div>
            ))}
            {!Object.keys(data?.queues ?? {}).length ? <div className="text-sm text-muted">Загрузка очередей…</div> : null}
          </div>
        </HudPanel>
      </section>

      {/* Live feed */}
      <HudPanel kicker="Live Feed" title="Последние находки" noPadding action={<Bell className="size-4 text-accent-soft" />}>
        <div className="p-4 sm:p-5">
          <LiveFeed listings={listingData?.listings} isLoading={listingsLoading} />
        </div>
      </HudPanel>
    </div>
  )
}

function Readiness({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <LiveDot tone={ok ? "success" : "danger"} live={ok} />
      <span className={ok ? "text-fg-dim" : "text-muted"}>{label}</span>
    </div>
  )
}

function ActionBanner({ tone, title, text, action }: { tone: "danger" | "warning"; title: string; text: string; action?: React.ReactNode }) {
  return (
    <div className={`flex flex-col gap-3 rounded-xl border px-4 py-3.5 md:flex-row md:items-center md:justify-between ${tone === "danger" ? "border-danger/40 bg-danger/10" : "border-warning/40 bg-warning/10"}`}>
      <div className="min-w-0">
        <div className={`kicker ${tone === "danger" ? "text-danger" : "text-warning"}`}>{title}</div>
        <div className="mt-1 text-sm text-foreground">{text}</div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

function MiniStat({ label, value, tone = "default" }: { label: string; value: number; tone?: "default" | "warning" }) {
  return (
    <div>
      <div className={`num text-lg font-semibold ${tone === "warning" ? "text-warning" : "text-foreground"}`}>{value}</div>
      <div className="text-[10px] tracking-widest text-muted uppercase">{label}</div>
    </div>
  )
}

function LaneRow({ lane, max }: { lane: MetricsResponse["laneRunsToday"][number]; max: number }) {
  const labels: Record<string, string> = { REALTIME: "Реалтайм", BACKFILL: "Глубокий", MANUAL: "Ручной" }
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-xs text-muted">{labels[lane.lane] ?? lane.lane}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
        <div className="h-full rounded-full bg-gradient-to-r from-accent-deep to-accent-soft" style={{ width: `${Math.max(3, (lane.found / max) * 100)}%` }} />
      </div>
      <span className="num w-16 shrink-0 text-right text-xs text-fg-dim">{lane.found} найд.</span>
    </div>
  )
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted">{label}</span>
      <span className="num font-medium text-fg-dim">{value}</span>
    </div>
  )
}

function QueueCell({ value, label, danger }: { value: number; label: string; danger?: boolean }) {
  return (
    <div>
      <div className={`num font-semibold ${danger ? "text-danger" : "text-foreground"}`}>{value}</div>
      <div className="text-[10px] text-muted">{label}</div>
    </div>
  )
}

function ratioAgainst(value: number | null, target: number): number {
  if (value == null) return 0
  return Math.min(1, value / target)
}

function toneForLatency(value: number | null, target: number): "success" | "warning" | "danger" {
  if (value == null) return "warning"
  if (value <= target) return "success"
  if (value <= target * 2) return "warning"
  return "danger"
}
