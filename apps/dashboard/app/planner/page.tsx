"use client"

import Link from "next/link"
import useSWR from "swr"
import { AlertTriangle, CheckCircle2, Clock, DatabaseZap, Gauge, ListChecks, ShieldAlert, Zap } from "lucide-react"
import { clientApi as api } from "@/lib/client-api"
import type { SearchPlanResponse, SearchPlanRow } from "@/lib/types"
import { HudPanel } from "@/components/hud/hud-panel"
import { MetricCard } from "@/components/hud/metric-card"
import { StatusBadge } from "@/components/hud/status-badge"
import { DataTable, type Column } from "@/components/ui/data-table"
import { cn } from "@/lib/utils"

const fetcher = <T,>(path: string) => api.get<T>(path)

function formatDate(value: string | null | undefined) {
  if (!value) return "—"
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value))
}

function percent(used: number, limit: number) {
  if (limit <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)))
}

function searchModeLabel(value: string) {
  const labels: Record<string, string> = {
    "api-filtered": "Фильтрация через API",
    "html-newest": "Публичная выдача: сначала новые",
    "html-local-sort": "Публичная выдача: локальная сортировка",
    "html-limited": "Публичная выдача: ограниченное время",
  }
  return labels[value] ?? value
}

function freshnessLabel(value: string) {
  const labels: Record<string, string> = {
    NEW_ONLY: "Только новые",
    LAST_24_HOURS: "Последние 24 часа",
    ALL_TIME: "Без ограничения по времени",
  }
  return labels[value] ?? value
}

function runStatusLabel(value: string) {
  const labels: Record<string, string> = {
    RUNNING: "Выполняется",
    SUCCESS: "Успешно",
    LIMITED: "С ограничениями",
    FAILED: "Ошибка",
    SKIPPED: "Пропущено",
  }
  return labels[value] ?? value
}

function olxChannelLabel(value: string) {
  const labels: Record<string, string> = {
    OLX_PUBLIC_API: "Быстрый публичный API",
    OLX_REGIONAL_API: "Региональная API-сверка",
    OLX_PRIVATE_API: "Private API-сверка",
    OLX_HTML_COVERAGE: "HTML-сверка",
    OLX_HTML_FALLBACK: "Резервный HTML-канал",
    LEGACY_UNATTRIBUTED: "До включения измерений",
  }
  return labels[value] ?? value
}

function formatDurationSeconds(value: number | null) {
  if (value == null) return "—"
  if (value < 60) return `${value} с`
  if (value < 3600) return `${Math.round(value / 60)} мин`
  return `${(value / 3600).toFixed(1)} ч`
}

export default function PlannerPage() {
  const { data, isLoading } = useSWR<SearchPlanResponse>("/search-plan", fetcher, { refreshInterval: 4000 })
  const plans = data?.plans ?? []
  const autoRiaRows = plans.filter((plan) => plan.source === "AUTO_RIA")
  const blocked = plans.filter((plan) => plan.severity === "danger")
  const warnings = plans.filter((plan) => plan.severity === "warning")

  const planColumns: Column<SearchPlanRow>[] = [
    {
      key: "source",
      header: "Источник",
      render: (plan) => (
        <div className="flex flex-col gap-1">
          <span className="font-mono text-xs text-foreground">{plan.source}</span>
          <StatusBadge status={plan.sourceStatus} />
        </div>
      ),
    },
    {
      key: "filter",
      header: "Фильтр",
      render: (plan) => (
        <div className="max-w-[240px]">
          <div className="font-semibold text-foreground">{plan.filterName}</div>
          <div className="mt-1 line-clamp-2 text-xs text-muted">{plan.filterSummary}</div>
        </div>
      ),
    },
    {
      key: "mode",
      header: "Режим",
      render: (plan) => (
        <div>
          <div className="text-xs text-accent-soft">{searchModeLabel(plan.supported.mode)}</div>
          <div className={cn("mt-1 inline-flex rounded-md border px-2 py-0.5 font-mono text-[10px]", plan.newestFirstVerifiedAt ? "border-success/30 bg-success/10 text-success" : "border-warning/30 bg-warning/10 text-warning")}>
            {plan.newestFirstVerifiedAt ? "СНАЧАЛА НОВЫЕ" : "ЛОКАЛЬНО"}
          </div>
        </div>
      ),
    },
    { key: "sync", header: "Синхронизация", render: (plan) => <span className="num text-xs text-muted">{formatDate(plan.initialSyncCompletedAt)}</span> },
    { key: "known", header: "Известно", align: "right", render: (plan) => <span className="num text-xs text-foreground">{plan.knownExternalIds}</span> },
    {
      key: "last",
      header: "Проверка",
      render: (plan) => (
        <div>
          <div className="num text-xs text-muted">{formatDate(plan.lastSuccessfulScanAt)}</div>
          {plan.recentRun ? <div className="mt-1 text-xs text-muted">{runStatusLabel(plan.recentRun.status)} · {plan.recentRun.foundCount}/{plan.recentRun.newCount} · {plan.recentRun.pageCount} стр.</div> : null}
        </div>
      ),
    },
    { key: "api", header: "Поля API", render: (plan) => <PillList values={plan.supported.apiFields} empty="нет" /> },
    { key: "post", header: "После загрузки", render: (plan) => <PillList values={plan.supported.postFilterFields} empty="нет" /> },
    { key: "issues", header: "Проблемы", render: (plan) => <IssueList plan={plan} compact /> },
  ]

  return (
    <div className="space-y-6 py-2">
      <header className="relative overflow-hidden rounded-2xl glass edge-light px-5 py-6 sm:px-7">
        <div className="pointer-events-none absolute -top-20 -right-10 size-56 rounded-full bg-accent/10 blur-3xl" />
        <div className="relative flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
          <div>
            <div className="kicker mb-2">План поиска</div>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl"><span className="text-gradient">Планировщик</span></h1>
            <p className="mt-2 max-w-3xl text-sm text-muted">
              Реальные контексты поиска: какие фильтры работают, завершена ли первичная синхронизация, какие поля уходят площадке и какие проверяются после загрузки.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link className="inline-flex h-10 items-center rounded-lg border border-line bg-surface-2 px-3.5 text-sm text-muted transition-colors hover:border-line-strong hover:text-foreground" href="/filters">Фильтры</Link>
            <Link className="inline-flex h-10 items-center rounded-lg border border-line bg-surface-2 px-3.5 text-sm text-muted transition-colors hover:border-line-strong hover:text-foreground" href="/sources">Источники</Link>
          </div>
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Контексты" value={data?.totals.plannedContexts ?? 0} icon={<ListChecks />} hint={`активных фильтров: ${data?.totals.activeFilters ?? 0}`} />
        <MetricCard label="AUTO.RIA" value={data?.totals.autoRiaContexts ?? 0} icon={<Zap />} hint={`до ${data?.totals.autoRiaEstimatedRequestsPerScan ?? 0} запросов за проверку`} />
        <MetricCard label="Первичная синхронизация" value={data?.totals.initialSyncPending ?? 0} icon={<Clock />} hint="Без повторной отправки старых объявлений" />
        <MetricCard label="Предупреждения" value={data?.totals.warnings ?? 0} icon={<AlertTriangle />} hint="Нужно внимание" />
        <MetricCard label="Блокировки" value={data?.totals.blocked ?? 0} icon={<ShieldAlert />} hint="Контекст не сканирует корректно" />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1fr_1.6fr]">
        <HudPanel title="Лимиты AUTO.RIA" action={<Gauge className="size-4 text-accent-soft" />}>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <QuotaMeter label="Пакет запросов" used={data?.autoRia.totalUsed ?? 0} limit={data?.autoRia.totalLimit ?? 0} />
              <QuotaMeter label="За час" used={data?.autoRia.hourlyUsed ?? 0} limit={data?.autoRia.hourlyLimit ?? 0} />
            </div>
            <div className="grid gap-2 text-sm text-muted sm:grid-cols-2">
              <StatusLine label="API-ключ" ok={Boolean(data?.autoRia.configured)} value={data?.autoRia.configured ? "настроен" : "нет"} />
              <StatusLine label="ID пользователя" ok={Boolean(data?.autoRia.userIdConfigured)} value={data?.autoRia.userIdConfigured ? "настроен" : "нет"} />
              <StatusLine label="Платные методы" ok={!data?.autoRia.paidMethodsEnabled} value={data?.autoRia.paidMethodsEnabled ? "включены" : "выключены"} />
              <StatusLine label="VIN-поиск" ok={!data?.autoRia.vinLookupEnabled} value={data?.autoRia.vinLookupEnabled ? "включен" : "выключен"} />
            </div>
            <div className="rounded-lg border border-border bg-panel-alt/45 p-3 text-xs text-muted">
              Резерв: {data?.autoRia.softReserve ?? 0} запросов всего, {data?.autoRia.minSearchReserve ?? 0} оставлено под поиск. Подробных карточек за проход: до {data?.autoRia.maxInfoPerScan ?? 0}.
            </div>
            <div className="rounded-lg border border-border bg-panel-alt/45 p-3 text-xs text-muted">
              Первичный проход: <span className="text-foreground">{data?.autoRia.initialWindowBehavior === "NOTIFY_MATCHING_IN_WINDOW" ? "отправлять подходящие" : "только запомнить существующие"}</span>. Максимум стартовых уведомлений:{" "}
              <span className="font-mono text-foreground">{data?.autoRia.maxInitialWindowNotifications ?? 50}</span>.
            </div>
            <div className="rounded-lg border border-border bg-panel-alt/45 p-3 text-xs text-muted">
              Глубокая проверка: каждые <span className="font-mono text-foreground">{data?.backfill.intervalSeconds ?? 600} с</span>, до{" "}
              <span className="font-mono text-foreground">{data?.backfill.maxPages ?? 4}</span> страниц и{" "}
              <span className="font-mono text-foreground">{data?.backfill.maxCandidates ?? 300}</span> объявлений; параллельность{" "}
              <span className="font-mono text-foreground">{data?.backfill.concurrency ?? 1}</span>.
            </div>
            {data?.autoRia.initialWindowBehavior === "NOTIFY_MATCHING_IN_WINDOW" ? (
              <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
                Включена отправка существующих объявлений из начального окна. Сначала отправляются самые свежие.
              </div>
            ) : null}
          </div>
        </HudPanel>

        <HudPanel title="Здоровье планировщика" action={blocked.length ? <ShieldAlert className="size-4 text-danger" /> : <CheckCircle2 className="size-4 text-success" />}>
          <div className="grid gap-3 md:grid-cols-2">
            <HealthBucket title="Блокировки" rows={blocked} tone="danger" />
            <HealthBucket title="Предупреждения" rows={warnings} tone="warning" />
          </div>
        </HudPanel>
      </section>

      <HudPanel kicker="OLX" title="Фактические каналы обнаружения за 24 часа" action={<Gauge className="size-4 text-accent-soft" />}>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(data?.olxDiscovery.channels ?? []).map((channel) => (
            <div key={channel.channel} className="surface-card rounded-xl p-3">
              <div className="text-xs font-semibold text-foreground">{olxChannelLabel(channel.channel)}</div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-muted">
                <div><span className="block font-mono text-foreground">{channel.sampleCount}</span>найдено</div>
                <div><span className="block font-mono text-foreground">{formatDurationSeconds(channel.p50Seconds)}</span>p50</div>
                <div><span className="block font-mono text-foreground">{formatDurationSeconds(channel.p95Seconds)}</span>p95</div>
              </div>
              <div className="mt-2 text-[11px] text-muted">Задержка рассчитана для {channel.latencySampleCount} объявлений с точным временем публикации.</div>
            </div>
          ))}
          {!data?.olxDiscovery.channels.length ? <div className="text-sm text-muted">Новые OLX-наблюдения ещё не накоплены.</div> : null}
        </div>
      </HudPanel>

      <HudPanel kicker="Контексты" title="Контексты поиска" action={<DatabaseZap className="size-4 text-accent-soft" />} noPadding>
        <div className="p-4 sm:p-5">
          <DataTable
            columns={planColumns}
            rows={plans}
            getKey={(plan) => plan.id}
            minWidth={1040}
            empty={isLoading ? "Загрузка контекстов…" : "Нет активных контекстов. Включите хотя бы один фильтр."}
          />
        </div>
      </HudPanel>

      <HudPanel title="Контексты AUTO.RIA">
        <div className="grid gap-3 xl:grid-cols-2">
          {autoRiaRows.map((plan) => (
            <div key={plan.id} className="rounded-lg border border-border bg-panel-alt/45 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-semibold text-foreground">{plan.filterName}</div>
                  <div className="mt-1 font-mono text-xs text-muted">{plan.fingerprint ?? "состояния пока нет"}</div>
                </div>
                <StatusBadge status={plan.severity === "ok" ? "ACTIVE" : plan.severity.toUpperCase()} />
              </div>
              <div className="mt-3 grid gap-2 text-sm text-muted sm:grid-cols-2">
                <div>Сводка: <span className="text-foreground">{plan.filterSummary}</span></div>
                <div>Свежесть: <span className="text-foreground">{freshnessLabel(plan.freshnessMode)}</span></div>
                <div>Последняя публикация: <span className="font-mono text-foreground">{formatDate(plan.lastPublishedAt)}</span></div>
                <div>Граница скана: <span className="font-mono text-foreground">{formatDate(plan.lastCompletedCutoff)}</span></div>
                <div>Самое старое обработанное: <span className="font-mono text-foreground">{formatDate(plan.oldestScannedPublishedAt)}</span></div>
                <div>Макс. запросов: <span className="font-mono text-foreground">{plan.estimatedRequestsPerScan}</span></div>
              </div>
              <IssueList plan={plan} />
            </div>
          ))}
          {!autoRiaRows.length ? <div className="text-sm text-muted">Нет активных контекстов AUTO.RIA.</div> : null}
        </div>
      </HudPanel>
    </div>
  )
}

function QuotaMeter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const value = percent(used, limit)
  return (
    <div className="surface-card rounded-xl p-3">
      <div className="flex items-center justify-between text-xs text-muted">
        <span>{label}</span>
        <span className="num font-semibold text-fg-dim">{used}/{limit}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-3">
        <div className="h-full rounded-full bg-gradient-to-r from-accent-deep to-accent-soft transition-[width] duration-700 ease-out" style={{ width: `${value}%` }} />
      </div>
      <div className="num mt-2 text-xs text-muted">осталось: {Math.max(0, limit - used)}</div>
    </div>
  )
}

function StatusLine({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="surface-card rounded-xl p-3">
      <div className="text-[11px] font-semibold tracking-widest text-muted uppercase">{label}</div>
      <div className={cn("num mt-1 text-sm", ok ? "text-success" : "text-danger")}>{value}</div>
    </div>
  )
}

function HealthBucket({ title, rows, tone }: { title: string; rows: SearchPlanRow[]; tone: "warning" | "danger" }) {
  return (
    <div className="surface-card rounded-xl p-3">
      <div className={cn("font-mono text-xs uppercase", tone === "danger" ? "text-danger" : "text-warning")}>{title}</div>
      <div className="mt-2 space-y-2">
        {rows.slice(0, 4).map((row) => (
          <div key={row.id} className="text-xs text-muted">
            <span className="font-mono text-foreground">{row.source}</span> · {row.filterName}: {row.issues[0]?.message ?? row.severity}
          </div>
        ))}
        {!rows.length ? <div className="text-xs text-muted">Чисто</div> : null}
      </div>
    </div>
  )
}

function PillList({ values, empty }: { values: string[]; empty: string }) {
  if (!values.length) return <span className="text-xs text-muted">{empty}</span>
  return (
    <div className="flex max-w-[240px] flex-wrap gap-1">
      {values.slice(0, 8).map((value) => (
        <span key={value} className="rounded-md border border-line bg-surface-1/60 px-2 py-1 font-mono text-[11px] text-muted">{value}</span>
      ))}
      {values.length > 8 ? <span className="text-xs text-muted">+{values.length - 8}</span> : null}
    </div>
  )
}

function IssueList({ plan, compact = false }: { plan: SearchPlanRow; compact?: boolean }) {
  if (!plan.issues.length) return <div className="text-xs text-success">Чисто</div>
  return (
    <div className={compact ? "max-w-[220px] space-y-1" : "mt-3 space-y-2"}>
      {plan.issues.slice(0, compact ? 2 : 6).map((issue, index) => (
        <div
          key={`${issue.message}-${index}`}
          className={cn(
            "rounded-md border px-2 py-1 text-xs",
            issue.level === "danger"
              ? "border-danger/30 bg-danger/10 text-danger"
              : "border-warning/30 bg-warning/10 text-warning",
          )}
        >
          {issue.message}
        </div>
      ))}
    </div>
  )
}
