"use client"

import type React from "react"
import { AnimatePresence, motion } from "framer-motion"
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react"
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils"

export type ToastTone = "success" | "error" | "warning" | "info"

type Toast = { id: number; tone: ToastTone; title: string; description?: string; duration: number }

type ToastInput = { tone?: ToastTone; title: string; description?: string; duration?: number }

const ToastContext = createContext<{ toast: (input: ToastInput) => void } | null>(null)

const TONE_META: Record<ToastTone, { icon: typeof CheckCircle2; ring: string; text: string; bar: string }> = {
  success: { icon: CheckCircle2, ring: "border-success/40", text: "text-success", bar: "bg-success" },
  error: { icon: XCircle, ring: "border-danger/40", text: "text-danger", bar: "bg-danger" },
  warning: { icon: AlertTriangle, ring: "border-warning/40", text: "text-warning", bar: "bg-warning" },
  info: { icon: Info, ring: "border-accent/40", text: "text-accent-soft", bar: "bg-accent" },
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const counter = useRef(0)

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback((input: ToastInput) => {
    const id = ++counter.current
    const duration = input.duration ?? 4200
    setToasts((prev) => [...prev.slice(-3), { id, tone: input.tone ?? "info", title: input.title, description: input.description, duration }])
  }, [])

  const value = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[120] flex flex-col items-center gap-2 px-3 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:items-end sm:px-6">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <ToastCard key={t.id} toast={t} onDismiss={dismiss} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const meta = TONE_META[toast.tone]
  const Icon = meta.icon

  // Depend only on stable values (id, duration, the memoized dismiss) so the
  // countdown is not reset every time another toast is added or removed.
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), toast.duration)
    return () => window.clearTimeout(timer)
  }, [toast.id, toast.duration, onDismiss])

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -18, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, scale: 0.95, transition: { duration: 0.2 } }}
      transition={{ type: "spring", stiffness: 460, damping: 34 }}
      className={cn(
        "glass-2 pointer-events-auto relative w-full max-w-sm overflow-hidden rounded-xl border pl-4 pr-3 py-3 shadow-[var(--shadow-3)]",
        meta.ring,
      )}
      role="status"
    >
      <span className={cn("absolute inset-y-0 left-0 w-[3px]", meta.bar)} />
      <div className="flex items-start gap-3">
        <Icon className={cn("mt-0.5 size-5 shrink-0", meta.text)} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">{toast.title}</div>
          {toast.description ? <div className="mt-0.5 text-xs leading-relaxed text-muted">{toast.description}</div> : null}
        </div>
        <button
          type="button"
          onClick={() => onDismiss(toast.id)}
          aria-label="Закрыть"
          className="-mr-1 rounded-md p-1 text-faint transition-colors hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    </motion.div>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) return { toast: () => undefined }
  return ctx
}
