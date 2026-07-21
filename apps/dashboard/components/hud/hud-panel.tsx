import type React from "react"
import { cn } from "@/lib/utils"

type HudPanelProps = {
  title?: string
  kicker?: string
  subtitle?: string
  action?: React.ReactNode
  className?: string
  bodyClassName?: string
  noPadding?: boolean
  interactive?: boolean
  children: React.ReactNode
}

/**
 * The primary content surface: matte glass with layered depth and a brushed
 * top edge. Header carries an optional kicker + title + action. Backward
 * compatible with the original { title, action, className, children } API.
 */
export function HudPanel({
  title,
  kicker,
  subtitle,
  action,
  className,
  bodyClassName,
  noPadding,
  interactive,
  children,
}: HudPanelProps) {
  return (
    <section
      className={cn(
        "edge-light group relative overflow-hidden rounded-2xl glass",
        interactive && "transition-all duration-300 hover:border-line-strong hover:shadow-[var(--shadow-3)]",
        className,
      )}
    >
      {title || action ? (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {kicker ? <div className="kicker mb-1 truncate">{kicker}</div> : null}
            {title ? (
              <h2 className="truncate text-sm font-semibold tracking-wide text-foreground">{title}</h2>
            ) : null}
            {subtitle ? <p className="mt-0.5 truncate text-xs text-muted">{subtitle}</p> : null}
          </div>
          {action ? <div className="shrink-0 text-muted">{action}</div> : null}
        </header>
      ) : null}
      <div className={cn(!noPadding && "p-4 sm:p-5", bodyClassName)}>{children}</div>
    </section>
  )
}
