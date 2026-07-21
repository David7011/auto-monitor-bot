"use client"

import type React from "react"
import { motion } from "framer-motion"
import { useId } from "react"
import { cn } from "@/lib/utils"

type Option<T extends string> = { value: T; label: string; icon?: React.ReactNode }

type SegmentedProps<T extends string> = {
  options: Option<T>[]
  value: T
  onChange: (value: T) => void
  size?: "sm" | "md"
  className?: string
}

/** Animated segmented control with a shared sliding highlight (Framer layout). */
export function Segmented<T extends string>({ options, value, onChange, size = "md", className }: SegmentedProps<T>) {
  const groupId = useId()
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1 rounded-xl border border-line bg-surface-1/70 p-1 backdrop-blur",
        className,
      )}
      role="tablist"
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative inline-flex items-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors [&_svg]:size-4",
              size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-1.5 text-sm",
              active ? "text-foreground" : "text-muted hover:text-fg-dim",
            )}
          >
            {active ? (
              <motion.span
                layoutId={`seg-${groupId}`}
                className="absolute inset-0 rounded-lg border border-accent/40 bg-accent/12 shadow-[0_0_16px_-6px_rgba(242,106,31,0.5)]"
                transition={{ type: "spring", stiffness: 480, damping: 36 }}
              />
            ) : null}
            <span className="relative z-10 inline-flex items-center gap-1.5">
              {option.icon}
              {option.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
