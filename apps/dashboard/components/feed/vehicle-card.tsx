"use client"

import type React from "react"
import { useState } from "react"
import { CarFront, Clock, ExternalLink, Gauge, MapPin, Zap } from "lucide-react"
import type { ListingRow } from "@/lib/types"
import { formatMileage, formatPrice, formatRelative, sourceLabel } from "@/lib/format"
import { cn } from "@/lib/utils"

const VERDICT: Record<string, { label: string; cls: string }> = {
  HIGH_RISK_BARGAIN: { label: "Сильно ниже рынка", cls: "border-danger/40 bg-danger/12 text-danger" },
  BELOW_MARKET: { label: "Ниже рынка", cls: "border-success/40 bg-success/12 text-success" },
  FAIR: { label: "Рыночная цена", cls: "border-line-strong bg-surface-3 text-fg-dim" },
  ABOVE_MARKET: { label: "Выше рынка", cls: "border-warning/40 bg-warning/12 text-warning" },
}

function detectionDelay(listing: ListingRow): string | null {
  if (!listing.publishedAt) return null
  const published = new Date(listing.publishedAt).getTime()
  const seen = new Date(listing.firstSeenAt).getTime()
  if (Number.isNaN(published) || Number.isNaN(seen)) return null
  const diff = Math.max(0, seen - published)
  const sec = Math.round(diff / 1000)
  if (sec < 60) return `${sec} с`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} мин`
  return `${Math.round(min / 60)} ч`
}

export function VehicleCard({ listing }: { listing: ListingRow }) {
  const [imgOk, setImgOk] = useState(true)
  const photo = listing.photoUrls?.[0]
  const title = listing.title ?? ([listing.brand, listing.model].filter(Boolean).join(" ") || "Автомобиль")
  const price = formatPrice(listing.priceNormalized ?? listing.priceOriginal, listing.priceNormalized ? "USD" : listing.currencyOriginal)
  const mileage = formatMileage(listing.mileage)
  const verdict = listing.marketPriceEstimate?.verdict ? VERDICT[listing.marketPriceEstimate.verdict] : null
  const delay = detectionDelay(listing)

  return (
    <article className="surface-card group relative flex flex-col overflow-hidden rounded-xl transition-all duration-300 hover:-translate-y-1 hover:border-line-strong hover:shadow-[var(--shadow-3)]">
      <div className="relative aspect-[16/10] overflow-hidden bg-surface-3">
        {photo && imgOk ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photo}
            alt={title}
            loading="lazy"
            onError={() => setImgOk(false)}
            className="size-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex size-full items-center justify-center bg-gradient-to-br from-surface-3 to-surface-1">
            <CarFront className="size-12 text-faint" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent" />

        <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2.5">
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-black/55 px-2 py-1 font-mono text-[10px] font-semibold tracking-wider text-accent-soft backdrop-blur-sm">
            <span className="size-1.5 rounded-full bg-accent" />
            {sourceLabel(listing.source)}
          </span>
          {verdict ? (
            <span className={cn("rounded-lg border px-2 py-1 text-[10px] font-semibold backdrop-blur-sm", verdict.cls)}>{verdict.label}</span>
          ) : null}
        </div>

        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-3">
          <div className="min-w-0">
            <div className="num text-xl font-bold text-white drop-shadow">{price}</div>
          </div>
          {listing.year ? (
            <span className="num rounded-md border border-white/15 bg-black/45 px-2 py-0.5 text-xs font-semibold text-white backdrop-blur-sm">{listing.year}</span>
          ) : null}
        </div>
      </div>

      <div className="flex flex-1 flex-col p-3.5">
        <h3 className="line-clamp-1 text-sm font-semibold text-foreground" title={title}>{title}</h3>

        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {mileage ? <Spec icon={<Gauge className="size-3" />}>{mileage}</Spec> : null}
          {listing.enginePower ? <Spec icon={<Zap className="size-3" />}>{listing.enginePower} л.с.</Spec> : null}
          {listing.city ? <Spec icon={<MapPin className="size-3" />}>{listing.city}</Spec> : null}
        </div>

        <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3">
          <div className="flex items-center gap-1.5 text-[11px] text-muted">
            <Clock className="size-3" />
            <span>{formatRelative(listing.firstSeenAt)}</span>
            {delay ? <span className="text-faint">· найдено за {delay}</span> : null}
          </div>
          <a
            href={listing.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-surface-3 px-2.5 py-1.5 text-xs font-semibold text-fg-dim transition-colors hover:border-accent/50 hover:bg-accent/10 hover:text-accent-soft"
          >
            Открыть <ExternalLink className="size-3" />
          </a>
        </div>
      </div>
    </article>
  )
}

function Spec({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-1/70 px-1.5 py-0.5 text-[11px] text-fg-dim [&_svg]:text-muted">
      {icon}
      {children}
    </span>
  )
}
