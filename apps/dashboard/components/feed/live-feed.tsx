"use client"

import { AnimatePresence, motion } from "framer-motion"
import { Inbox } from "lucide-react"
import type { ListingRow } from "@/lib/types"
import { SkeletonCard } from "@/components/ui/skeleton"
import { VehicleCard } from "./vehicle-card"

type LiveFeedProps = {
  listings: ListingRow[] | undefined
  isLoading?: boolean
  columnsClassName?: string
}

/**
 * Live grid of found vehicles. New cards animate in from the top and reflow
 * with a spring (Framer layout), so a fresh detection visibly slides in.
 */
export function LiveFeed({ listings, isLoading, columnsClassName }: LiveFeedProps) {
  const cols = columnsClassName ?? "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3"

  if (isLoading && !listings) {
    return (
      <div className={`grid gap-4 ${cols}`}>
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    )
  }

  if (!listings || listings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line-strong bg-surface-1/40 px-6 py-16 text-center">
        <div className="mb-3 flex size-14 items-center justify-center rounded-2xl border border-line bg-surface-2 text-faint">
          <Inbox className="size-6" />
        </div>
        <div className="text-sm font-semibold text-foreground">Пока нет найденных автомобилей</div>
        <p className="mt-1 max-w-sm text-xs text-muted">
          Создайте боевой фильтр и запустите мониторинг — новые объявления появятся здесь в реальном времени.
        </p>
      </div>
    )
  }

  return (
    <motion.div layout className={`grid gap-4 ${cols}`}>
      <AnimatePresence initial={false} mode="popLayout">
        {listings.map((listing) => (
          <motion.div
            key={listing.id}
            layout
            initial={{ opacity: 0, y: -22, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.2 } }}
            transition={{ type: "spring", stiffness: 380, damping: 34 }}
          >
            <VehicleCard listing={listing} />
          </motion.div>
        ))}
      </AnimatePresence>
    </motion.div>
  )
}
