"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import type React from "react"
import { useEffect, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import useSWR from "swr"
import { Car, FileText, Gauge, ListChecks, ListFilter, Menu, RadioTower, Settings, X } from "lucide-react"
import { clientApi } from "@/lib/client-api"
import type { MonitoringStatusResponse } from "@/lib/types"
import { cn } from "@/lib/utils"

type NavItem = { href: string; label: string; mobileLabel?: string; icon: typeof Gauge; section: string }

const NAV: NavItem[] = [
  { href: "/", label: "Пульт", mobileLabel: "Пульт", icon: Gauge, section: "Командный центр" },
  { href: "/planner", label: "План поиска", icon: ListChecks, section: "План поиска" },
  { href: "/filters", label: "Фильтры", mobileLabel: "Фильтры", icon: ListFilter, section: "Фильтры поиска" },
  { href: "/sources", label: "Источники", mobileLabel: "Источники", icon: RadioTower, section: "Центр источников" },
  { href: "/listings", label: "Объявления", mobileLabel: "Авто", icon: Car, section: "Найденные авто" },
  { href: "/logs", label: "Логи", icon: FileText, section: "Журнал системы" },
  { href: "/settings", label: "Настройки", icon: Settings, section: "Настройки" },
]

const MOBILE_NAV = NAV.filter((item) => ["/", "/filters", "/sources", "/listings"].includes(item.href))

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href)
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  useEffect(() => setMobileMenuOpen(false), [pathname])

  useEffect(() => {
    if (!mobileMenuOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && setMobileMenuOpen(false)
    window.addEventListener("keydown", closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener("keydown", closeOnEscape)
    }
  }, [mobileMenuOpen])

  const activeSection = NAV.find((item) => isActive(pathname, item.href))?.section ?? "Центр мониторинга"

  if (pathname === "/login") {
    return <div className="min-h-screen">{children}</div>
  }

  return (
    <div className="relative min-h-screen">
      <div className="relative mx-auto flex min-h-screen max-w-[1560px]">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col border-r border-line bg-surface-1/50 backdrop-blur-2xl lg:flex">
          <div className="flex items-center gap-3 px-5 pt-6 pb-5">
            <BrandMark />
            <div className="min-w-0">
              <div className="text-sm font-bold tracking-[0.2em] text-foreground uppercase">Auto Monitor</div>
              <div className="kicker mt-0.5">Центр мониторинга</div>
            </div>
          </div>

          <nav className="flex-1 space-y-1 px-3">
            {NAV.map((item) => (
              <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} />
            ))}
          </nav>

          <CoreStatus />
        </aside>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar section={activeSection} onOpenMenu={() => setMobileMenuOpen(true)} />
          <main className="min-w-0 flex-1 px-3 pb-28 sm:px-6 sm:pb-10 lg:px-8">
            {/* CSS-only enter animation: route transitions must never depend on
                JS animation state — AnimatePresence around App Router children
                leaves pages stuck at opacity 0. Keyed div restarts the CSS
                animation on every pathname change. */}
            <div key={pathname} className="route-enter">
              {children}
            </div>
          </main>
        </div>
      </div>

      {/* Mobile drawer */}
      <AnimatePresence>
        {mobileMenuOpen ? (
          <div className="fixed inset-0 z-[110] lg:hidden" role="dialog" aria-modal="true" aria-label="Все разделы">
            <motion.button
              type="button"
              aria-label="Закрыть меню"
              className="absolute inset-0 bg-black/70 backdrop-blur-sm"
              onClick={() => setMobileMenuOpen(false)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            />
            <motion.aside
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", stiffness: 420, damping: 40 }}
              className="absolute inset-y-0 left-0 flex w-[min(86vw,20rem)] flex-col border-r border-line bg-surface-1/95 px-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-[calc(1rem+env(safe-area-inset-bottom))] backdrop-blur-2xl"
            >
              <div className="mb-5 flex items-center justify-between gap-3 border-b border-line pb-4">
                <div className="flex items-center gap-3">
                  <BrandMark />
                  <div>
                    <div className="text-sm font-bold tracking-[0.16em] uppercase">Auto Monitor</div>
                    <div className="kicker mt-0.5">Все разделы</div>
                  </div>
                </div>
                <button
                  type="button"
                  aria-label="Закрыть меню"
                  onClick={() => setMobileMenuOpen(false)}
                  className="flex size-10 items-center justify-center rounded-lg border border-line text-muted active:text-foreground"
                >
                  <X className="size-5" />
                </button>
              </div>
              <nav className="space-y-1 overflow-y-auto">
                {NAV.map((item) => (
                  <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} large />
                ))}
              </nav>
              <div className="mt-auto pt-4">
                <CoreStatus compact />
              </div>
            </motion.aside>
          </div>
        ) : null}
      </AnimatePresence>

      <MobileTabBar pathname={pathname} onMore={() => setMobileMenuOpen(true)} moreActive={mobileMenuOpen} />
    </div>
  )
}

function BrandMark() {
  return (
    <div className="relative flex size-11 shrink-0 items-center justify-center rounded-xl border border-accent/40 bg-gradient-to-b from-accent/20 to-accent/5 text-accent-soft shadow-[0_0_28px_-4px_rgba(242,106,31,0.5)]">
      <span className="absolute inset-0 rounded-xl border border-accent/20" style={{ animation: "ping-ring 3s cubic-bezier(0,0,0.2,1) infinite" }} />
      <RadioTower className="relative size-5" />
    </div>
  )
}

function NavLink({ item, active, large }: { item: NavItem; active: boolean; large?: boolean }) {
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      className={cn(
        "group relative flex items-center gap-3 rounded-xl px-3 transition-colors",
        large ? "min-h-12 text-sm font-semibold" : "py-2.5 text-sm",
        active ? "text-accent-soft" : "text-muted hover:text-foreground",
      )}
    >
      {active ? (
        <motion.span
          layoutId="nav-active"
          className="absolute inset-0 rounded-xl border border-accent/40 bg-accent/10 shadow-[0_0_22px_-8px_rgba(242,106,31,0.6)]"
          transition={{ type: "spring", stiffness: 520, damping: 40 }}
        />
      ) : null}
      <Icon className={cn("relative z-10 size-[18px] shrink-0 transition-transform", active && "drop-shadow-[0_0_6px_rgba(242,106,31,0.6)]", !active && "group-hover:scale-110")} />
      <span className="relative z-10">{item.label}</span>
    </Link>
  )
}

function CoreStatus({ compact }: { compact?: boolean }) {
  const { data } = useSWR<MonitoringStatusResponse>("/monitoring/status", (path: string) => clientApi.get(path), {
    refreshInterval: 5000,
  })
  const status = data?.state.status ?? "…"
  const running = status === "RUNNING"
  const live = data?.mode === "LIVE" && running

  return (
    <div className={cn("border-t border-line px-4 py-4", compact && "rounded-xl border")}>
      <div className="flex items-center gap-2.5">
        <span className="relative flex size-2.5 items-center justify-center">
          {running ? (
            <span className={cn("absolute inline-flex size-full rounded-full", live ? "bg-accent/60" : "bg-success/60")} style={{ animation: "ping-ring 2s cubic-bezier(0,0,0.2,1) infinite" }} />
          ) : null}
          <span className={cn("relative size-1.5 rounded-full", running ? (live ? "bg-accent" : "bg-success") : "bg-muted")} />
        </span>
        <div className="min-w-0">
          <div className="text-xs font-semibold text-foreground">
            {running ? (live ? "LIVE-мониторинг" : "Мониторинг активен") : "Мониторинг остановлен"}
          </div>
          <div className="kicker mt-0.5 truncate">
            {data ? `поколение ${data.state.generation} · ${data.sources.filter((s) => s.enabled).length} источн.` : "подключение…"}
          </div>
        </div>
      </div>
    </div>
  )
}

const CLOCK_FMT = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })

function TopBar({ section, onOpenMenu }: { section: string; onOpenMenu: () => void }) {
  const [clock, setClock] = useState("")
  useEffect(() => {
    const tick = () => setClock(CLOCK_FMT.format(new Date()))
    tick()
    const t = window.setInterval(tick, 1000)
    return () => window.clearInterval(t)
  }, [])

  return (
    <div className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-line bg-surface-1/40 px-3 py-3 backdrop-blur-xl sm:px-6 lg:px-8">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          aria-label="Открыть разделы"
          onClick={onOpenMenu}
          className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-foreground active:border-accent/60 lg:hidden"
        >
          <Menu className="size-5" />
        </button>
        <div className="min-w-0">
          <div className="kicker">Auto Monitor</div>
          <div className="truncate text-sm font-semibold text-foreground">{section}</div>
        </div>
      </div>
      <div className="hidden items-center gap-2 rounded-lg border border-line bg-surface-2/60 px-3 py-1.5 sm:flex">
        <span className="size-1.5 animate-pulse-glow rounded-full bg-accent" />
        <span className="num text-xs tracking-wider text-fg-dim">{clock}</span>
      </div>
    </div>
  )
}

function MobileTabBar({ pathname, onMore, moreActive }: { pathname: string; onMore: () => void; moreActive: boolean }) {
  return (
    <nav
      aria-label="Мобильная навигация"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-line bg-surface-1/95 px-1 pt-1.5 pb-[calc(0.4rem+env(safe-area-inset-bottom))] shadow-[0_-14px_44px_rgba(0,0,0,0.5)] backdrop-blur-2xl lg:hidden"
    >
      <div className="mx-auto grid max-w-xl grid-cols-5 gap-0.5">
        {MOBILE_NAV.map((item) => {
          const active = isActive(pathname, item.href)
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.label}
              className={cn(
                "flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-lg border px-0.5 text-center text-[10px] font-semibold leading-tight transition-colors",
                active ? "border-accent/45 bg-accent/12 text-accent-soft" : "border-transparent text-muted active:bg-surface-3 active:text-foreground",
              )}
            >
              <Icon className="size-[18px]" />
              <span className="max-w-full break-words">{item.mobileLabel ?? item.label}</span>
            </Link>
          )
        })}
        <button
          type="button"
          aria-label="Открыть остальные разделы"
          onClick={onMore}
          className={cn(
            "flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-lg border px-0.5 text-center text-[10px] font-semibold leading-tight transition-colors",
            moreActive ? "border-accent/45 bg-accent/12 text-accent-soft" : "border-transparent text-muted active:bg-surface-3 active:text-foreground",
          )}
        >
          <Menu className="size-[18px]" />
          <span>Ещё</span>
        </button>
      </div>
    </nav>
  )
}
