"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { clientApi as api } from "@/lib/client-api"
import type { ErrorLogRow } from "@/lib/types"
import { HudPanel } from "@/components/hud/hud-panel"
import { StatusBadge } from "@/components/hud/status-badge"
import { Segmented } from "@/components/ui/segmented"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"

const fetcher = <T,>(path: string) => api.get<T>(path)

const LEVEL_ACCENT: Record<string, string> = {
  ERROR: "border-l-danger",
  WARN: "border-l-warning",
  INFO: "border-l-line-strong",
}

export default function LogsPage() {
  const [level, setLevel] = useState<"ALL" | "INFO" | "WARN" | "ERROR">("ALL")
  const { data } = useSWR<{ logs: ErrorLogRow[] }>("/logs?limit=200", fetcher, { refreshInterval: 4000 })
  const logs = data?.logs ?? []

  const counts = useMemo(() => {
    const c = { INFO: 0, WARN: 0, ERROR: 0 }
    for (const log of logs) c[log.level] = (c[log.level] ?? 0) + 1
    return c
  }, [logs])

  const filtered = level === "ALL" ? logs : logs.filter((log) => log.level === level)

  return (
    <div className="space-y-6 py-2">
      <header className="relative overflow-hidden rounded-2xl glass edge-light px-5 py-6 sm:px-7">
        <div className="pointer-events-none absolute -top-20 -right-10 size-56 rounded-full bg-accent/10 blur-3xl" />
        <div className="relative flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <div className="kicker mb-2">Телеметрия системы</div>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl"><span className="text-gradient">Журнал системы</span></h1>
            <p className="mt-2 text-sm text-muted">
              <span className="text-danger">{counts.ERROR} ошибок</span> · <span className="text-warning">{counts.WARN} предупр.</span> · <span className="text-muted">{counts.INFO} инфо</span>
            </p>
          </div>
          <Segmented
            value={level}
            onChange={setLevel}
            size="sm"
            options={[
              { value: "ALL", label: "Все" },
              { value: "ERROR", label: "Ошибки" },
              { value: "WARN", label: "Предупр." },
              { value: "INFO", label: "Инфо" },
            ]}
          />
        </div>
      </header>

      <HudPanel noPadding>
        <div className="space-y-2 p-4 sm:p-5">
          {filtered.map((log) => (
            <div key={log.id} className={cn("rounded-lg border border-l-2 border-line bg-surface-1/50 p-3", LEVEL_ACCENT[log.level] ?? "border-l-line")}>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={log.level} />
                <span className="num font-mono text-xs text-muted">{formatDateTime(log.createdAt)}</span>
                <span className="font-mono text-xs text-accent-soft">{log.scope}</span>
              </div>
              <div className="mt-2 text-sm text-foreground">{log.message}</div>
              {log.details ? (
                <pre className="mt-2 overflow-x-auto rounded-lg border border-line bg-bg-deep/60 p-2.5 text-xs whitespace-pre-wrap text-muted">{log.details}</pre>
              ) : null}
            </div>
          ))}
          {!filtered.length ? <div className="py-10 text-center text-sm text-muted">Событий нет.</div> : null}
        </div>
      </HudPanel>
    </div>
  )
}
