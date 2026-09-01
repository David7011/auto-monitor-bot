import type { ListingSource, SourceStatus } from "@amb/db";

const AVAILABLE_STATUSES: SourceStatus[] = ["ACTIVE", "LIMITED"];

export function sourcePortfolioHealth(input: {
  sources: Array<{
    source: ListingSource;
    enabled: boolean;
    status: SourceStatus;
    intervalSeconds: number;
    lastSuccessfulAt: Date | null;
  }>;
  monitoringRunning?: boolean;
  now?: Date;
}): { status: "OK" | "WARN" | "FAIL"; message: string; activeFallbacks: ListingSource[] } {
  if (input.monitoringRunning === false) {
    return {
      status: "OK",
      message: "Мониторинг остановлен пользователем; свежесть live-покрытия не оценивается",
      activeFallbacks: [],
    };
  }
  const now = input.now ?? new Date();
  const available = input.sources.filter((source) => {
    if (!source.enabled || !AVAILABLE_STATUSES.includes(source.status) || !source.lastSuccessfulAt) return false;
    const freshnessMs = Math.max(5 * 60_000, source.intervalSeconds * 5_000);
    return now.getTime() - source.lastSuccessfulAt.getTime() <= freshnessMs;
  });
  const olxAvailable = available.some((source) => source.source === "OLX");
  const activeFallbacks = available
    .filter((source) => source.source !== "OLX" && source.source !== "MOCK")
    .map((source) => source.source);

  if (olxAvailable) {
    return {
      status: "OK",
      message: `OLX доступен; свежие резервные источники: ${activeFallbacks.join(", ") || "нет"}`,
      activeFallbacks,
    };
  }
  if (activeFallbacks.length >= 2) {
    return {
      status: "WARN",
      message: `OLX недоступен; деградированный live-режим поддерживают: ${activeFallbacks.join(", ")}`,
      activeFallbacks,
    };
  }
  return {
    status: "FAIL",
    message: activeFallbacks.length === 1
      ? `OLX недоступен; остался только один свежий резерв: ${activeFallbacks[0]}`
      : "OLX и свежие резервные источники недоступны",
    activeFallbacks,
  };
}
