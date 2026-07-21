"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import { Clock, Save, Send } from "lucide-react"
import { clientApi as api, dashboardErrorMessage } from "@/lib/client-api"
import type { SettingsResponse } from "@/lib/types"
import { HudPanel } from "@/components/hud/hud-panel"
import { GlowButton } from "@/components/hud/glow-button"
import { StatusBadge } from "@/components/hud/status-badge"
import { useToast } from "@/components/ui/toast"

const fetcher = <T,>(path: string) => api.get<T>(path)
const inputClass =
  "h-11 w-full rounded-lg border border-line bg-surface-2/80 px-3 text-sm text-foreground outline-none transition-all placeholder:text-faint focus:border-accent/60 focus:bg-surface-3 focus:ring-2 focus:ring-accent/20"

export default function SettingsPage() {
  const { data, mutate } = useSWR<SettingsResponse>("/settings", fetcher)
  const { toast } = useToast()
  const [intervalSeconds, setIntervalSeconds] = useState("120")
  const [jitterSeconds, setJitterSeconds] = useState("20")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!data) return
    setIntervalSeconds(String(data.intervalSeconds))
    setJitterSeconds(String(data.jitterSeconds))
  }, [data])

  async function save() {
    const interval = Number(intervalSeconds)
    const jitter = Number(jitterSeconds)
    if (!Number.isFinite(interval) || !Number.isFinite(jitter)) {
      toast({ tone: "error", title: "Неверные значения", description: "Интервал и задержка должны быть числами." })
      return
    }
    setSaving(true)
    try {
      await api.patch("/settings", { intervalSeconds: interval, jitterSeconds: jitter })
      await mutate()
      toast({ tone: "success", title: "Настройки сохранены" })
    } catch (err) {
      toast({ tone: "error", title: "Не удалось сохранить", description: dashboardErrorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6 py-2">
      <header className="relative overflow-hidden rounded-2xl glass edge-light px-5 py-6 sm:px-7">
        <div className="pointer-events-none absolute -top-20 -right-10 size-56 rounded-full bg-accent/10 blur-3xl" />
        <div className="relative">
          <div className="kicker mb-2">Конфигурация</div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl"><span className="text-gradient">Настройки</span></h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">Базовые интервалы планировщика по умолчанию. Отдельные интервалы источников задаются на странице источников и в .env.</p>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <HudPanel kicker="Планировщик" title="Интервалы проверки" action={<Clock className="size-4 text-accent-soft" />}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-[11px] font-semibold tracking-widest text-muted uppercase">Интервал, секунд</span>
              <input className={inputClass} inputMode="numeric" value={intervalSeconds} onChange={(e) => setIntervalSeconds(e.target.value)} placeholder={String(data?.intervalSeconds ?? 120)} />
            </label>
            <label className="space-y-1.5">
              <span className="text-[11px] font-semibold tracking-widest text-muted uppercase">Случайная задержка, секунд</span>
              <input className={inputClass} inputMode="numeric" value={jitterSeconds} onChange={(e) => setJitterSeconds(e.target.value)} placeholder={String(data?.jitterSeconds ?? 20)} />
            </label>
          </div>
          <div className="mt-5">
            <GlowButton loading={saving} onClick={save}><Save /> Сохранить</GlowButton>
          </div>
        </HudPanel>

        <HudPanel kicker="Уведомления" title="Telegram" action={<Send className="size-4 text-accent-soft" />}>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted">Статус</span>
            <StatusBadge status={data?.telegramConfigured ? "ACTIVE" : "DISABLED"} />
          </div>
          <div className="mt-4 space-y-2.5">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-1/50 px-3 py-2.5 text-sm">
              <span className="text-muted">Chat ID</span>
              <span className="num font-medium text-fg-dim">{data?.telegramChatId ?? "не настроен"}</span>
            </div>
            <p className="text-xs leading-relaxed text-muted">
              Для отправки ссылок укажите <span className="font-mono text-fg-dim">TELEGRAM_BOT_TOKEN</span> и <span className="font-mono text-fg-dim">TELEGRAM_CHAT_ID</span> в файле .env и перезапустите проект.
            </p>
          </div>
        </HudPanel>
      </div>
    </div>
  )
}
