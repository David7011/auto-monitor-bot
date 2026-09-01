"use client"

import { useState } from "react"
import useSWR from "swr"
import { LayoutGrid, Table2 } from "lucide-react"
import { clientApi as api } from "@/lib/client-api"
import type { ListingRow } from "@/lib/types"
import { HudPanel } from "@/components/hud/hud-panel"
import { StatusBadge } from "@/components/hud/status-badge"
import { Segmented } from "@/components/ui/segmented"
import { DataTable, type Column } from "@/components/ui/data-table"
import { LiveFeed } from "@/components/feed/live-feed"
import { formatDateTime, formatPrice, sourceLabel } from "@/lib/format"

const fetcher = <T,>(path: string) => api.get<T>(path)

export default function ListingsPage() {
  const [view, setView] = useState<"grid" | "table">("grid")
  const { data, isLoading } = useSWR<{ listings: ListingRow[] }>("/listings/recent?limit=100", fetcher, { refreshInterval: 5000 })
  const listings = data?.listings ?? []

  const columns: Column<ListingRow>[] = [
    { key: "time", header: "Время", render: (l) => <span className="num text-xs text-muted">{formatDateTime(l.firstSeenAt)}</span> },
    { key: "source", header: "Источник", render: (l) => <span className="font-medium text-fg-dim">{sourceLabel(l.source)}</span> },
    { key: "title", header: "Название", render: (l) => <span className="line-clamp-1 max-w-[240px]">{l.title ?? "—"}</span> },
    { key: "year", header: "Год", align: "right", render: (l) => <span className="num">{l.year ?? "—"}</span> },
    { key: "price", header: "Цена", align: "right", render: (l) => <span className="num font-semibold text-foreground">{formatPrice(l.priceNormalized ?? l.priceOriginal, l.priceNormalized ? "USD" : l.currencyOriginal)}</span> },
    { key: "market", header: "Рынок", render: (l) => <StatusBadge status={l.marketPriceEstimate?.verdict ?? "UNKNOWN"} /> },
    { key: "city", header: "Город", render: (l) => <span className="text-muted">{l.city ?? "—"}</span> },
    { key: "check", header: "Проверка", render: (l) => <StatusBadge status={l.vehicleChecks?.[0]?.checkStatus ?? "NOT_STARTED"} /> },
    {
      key: "tg",
      header: "Telegram",
      render: (l) => (
        <span className="flex items-center gap-1.5">
          <StatusBadge status={l.telegramNotifications?.[0]?.status ?? "PENDING"} />
          {l.telegramNotifications?.[0]?.favoritedAt ? <span title="Сохранено на 10 дней">❤️</span> : null}
        </span>
      ),
    },
    { key: "link", header: "", align: "right", render: (l) => <a className="text-accent-soft hover:underline" href={l.url} target="_blank" rel="noopener noreferrer">открыть</a> },
  ]

  return (
    <div className="space-y-6 py-2">
      <header className="relative overflow-hidden rounded-2xl glass edge-light px-5 py-6 sm:px-7">
        <div className="pointer-events-none absolute -top-20 -right-10 size-56 rounded-full bg-accent/10 blur-3xl" />
        <div className="relative flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <div className="kicker mb-2">База объявлений</div>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl"><span className="text-gradient">Найденные авто</span></h1>
            <p className="mt-2 text-sm text-muted">Всего в выборке: <span className="num font-semibold text-foreground">{listings.length}</span></p>
          </div>
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: "grid", label: "Плитки", icon: <LayoutGrid /> },
              { value: "table", label: "Таблица", icon: <Table2 /> },
            ]}
          />
        </div>
      </header>

      {view === "grid" ? (
        <LiveFeed listings={listings} isLoading={isLoading} columnsClassName="grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" />
      ) : (
        <HudPanel noPadding>
          <div className="p-4 sm:p-5">
            <DataTable columns={columns} rows={listings} getKey={(l) => l.id} minWidth={980} empty="Пока нет объявлений." />
          </div>
        </HudPanel>
      )}
    </div>
  )
}
