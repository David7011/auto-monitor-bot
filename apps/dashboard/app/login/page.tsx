"use client"

import type { FormEvent } from "react"
import { useState } from "react"
import { LogIn, RadioTower } from "lucide-react"
import { GlowButton } from "@/components/hud/glow-button"

const inputClass =
  "h-11 w-full rounded-lg border border-line bg-surface-2/80 px-3 text-sm text-foreground outline-none transition-all placeholder:text-faint focus:border-accent/60 focus:bg-surface-3 focus:ring-2 focus:ring-accent/20"

export default function LoginPage() {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      })
      if (!response.ok) {
        setError("Неверный логин или пароль")
        return
      }
      const params = new URLSearchParams(window.location.search)
      window.location.href = params.get("next") || "/"
    } catch {
      setError("Сервис входа сейчас недоступен")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="relative flex size-16 items-center justify-center rounded-2xl border border-accent/40 bg-gradient-to-b from-accent/20 to-accent/5 text-accent-soft shadow-[0_0_40px_-6px_rgba(242,106,31,0.55)]">
            <span className="absolute inset-0 rounded-2xl border border-accent/20" style={{ animation: "ping-ring 3s cubic-bezier(0,0,0.2,1) infinite" }} />
            <RadioTower className="relative size-7" />
          </div>
          <div className="kicker mt-4">Защищённый доступ</div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight"><span className="text-gradient">Auto Monitor</span></h1>
          <p className="mt-1 text-xs text-muted">Центр мониторинга автомобильного рынка</p>
        </div>

        <div className="glass-2 rounded-2xl p-6">
          <form className="space-y-4" onSubmit={submit}>
            <label className="block space-y-2">
              <span className="text-[11px] font-semibold tracking-widest text-muted uppercase">Логин</span>
              <input className={inputClass} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label className="block space-y-2">
              <span className="text-[11px] font-semibold tracking-widest text-muted uppercase">Пароль</span>
              <input className={inputClass} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {error ? <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div> : null}
            <GlowButton type="submit" className="w-full justify-center" loading={loading}>
              <LogIn /> {loading ? "Проверяю…" : "Войти"}
            </GlowButton>
          </form>
        </div>
      </div>
    </div>
  )
}
