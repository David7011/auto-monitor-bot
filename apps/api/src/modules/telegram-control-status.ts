import { Prisma, prisma } from "@amb/db";
import {
  FILTER_REJECTION_LABELS,
  type FilterRejectionReason,
} from "@amb/shared";
import { getMonitoringStatus } from "./monitoring/control.js";
import {
  formatSourceHealthLine,
  monitoringModeLabel,
  monitoringStatusLabel,
  sourceLabel,
} from "./telegram-control-format.js";

export async function formatPanelText(): Promise<string> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [status, observationCounts] = await Promise.all([
    getMonitoringStatus(),
    prisma.sourceSeenListing.groupBy({
      by: ["decision"],
      where: {
        normalizedData: { not: Prisma.JsonNull },
        OR: [{ publishedAt: { gte: cutoff } }, { firstSeenAt: { gte: cutoff } }],
      },
      _count: { _all: true },
    }),
  ]);
  const queueTotals = Object.values(status.queues).reduce(
    (acc, counts) => ({
      waiting: acc.waiting + counts.waiting,
      active: acc.active + counts.active,
      failed: acc.failed + counts.failed,
    }),
    { waiting: 0, active: 0, failed: 0 },
  );
  const sourceLines = status.sources
    .filter((source) =>
      ["AUTO_RIA", "OLX", "RST", "CARS_UA", "AUTOMOTO"].includes(source.source)
      && source.enabled)
    .map((source) => formatSourceHealthLine(source));
  const observed24h = observationCounts.reduce((sum, row) => sum + row._count._all, 0);
  const notified24h = observationCounts.find((row) => row.decision === "NOTIFIED")?._count._all ?? 0;
  const unresolved24h = observationCounts
    .filter((row) => ["PENDING", "MATCHED", "FAILED"].includes(row.decision))
    .reduce((sum, row) => sum + row._count._all, 0);
  return trimTelegramMessage([
    "Автомонитор",
    `Статус: ${monitoringStatusLabel(status.state.status)}`,
    `Режим: ${monitoringModeLabel(status.mode)}`,
    `Сегодня: ${status.foundToday}`,
    `Фильтры: ${status.filters.activeReal}/${status.filters.total}`,
    `Очередь: ${queueTotals.waiting} ждут, ${queueTotals.active} в работе, ${queueTotals.failed} ошибок`,
    `Контроль 24 ч: ${observed24h} увидено, ${notified24h} отправлено, ${unresolved24h} требуют проверки`,
    "Источники:",
    ...(sourceLines.length > 0 ? sourceLines : ["не включены"]),
  ].join("\n"));
}

export async function formatCompletenessText(): Promise<string> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const where = {
    normalizedData: { not: Prisma.JsonNull },
    OR: [{ publishedAt: { gte: cutoff } }, { firstSeenAt: { gte: cutoff } }],
  } satisfies Prisma.SourceSeenListingWhereInput;
  const [byDecision, bySource, latestAudit, rejected, legacyWithoutSnapshot] = await Promise.all([
    prisma.sourceSeenListing.groupBy({ by: ["decision"], where, _count: { _all: true } }),
    prisma.sourceSeenListing.groupBy({ by: ["source"], where, _count: { _all: true } }),
    prisma.completenessAudit.findFirst({ orderBy: { startedAt: "desc" } }),
    prisma.sourceSeenListing.findMany({
      where: { ...where, decision: "REJECTED" },
      select: { rejectionReasons: true },
      take: 2_000,
    }),
    prisma.sourceSeenListing.count({
      where: {
        normalizedData: { equals: Prisma.DbNull },
        OR: [{ publishedAt: { gte: cutoff } }, { firstSeenAt: { gte: cutoff } }],
      },
    }),
  ]);
  const decisionCount = (decision: string) =>
    byDecision.find((row) => row.decision === decision)?._count._all ?? 0;
  const observed = byDecision.reduce((sum, row) => sum + row._count._all, 0);
  const rejectionCounts = new Map<string, number>();
  for (const row of rejected) {
    for (const reason of row.rejectionReasons) {
      rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + 1);
    }
  }
  const topReasons = [...rejectionCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([reason, count]) =>
      `${FILTER_REJECTION_LABELS[reason as FilterRejectionReason] ?? reason}: ${count}`);

  return trimTelegramMessage([
    "Полнота мониторинга за 24 часа",
    `Увидено: ${observed}`,
    `Отправлено: ${decisionCount("NOTIFIED")}`,
    `Отсеяно фильтрами: ${decisionCount("REJECTED")}`,
    `Ожидают решения: ${decisionCount("PENDING") + decisionCount("MATCHED") + decisionCount("FAILED")}`,
    `Исторические ID без снимка: ${legacyWithoutSnapshot}`,
    `По источникам: ${bySource.map((row) => `${sourceLabel(row.source)} ${row._count._all}`).join(", ") || "нет данных"}`,
    latestAudit
      ? `Последняя сверка: обработано ${latestAudit.evaluatedCount}, восстановлено ${latestAudit.dispatchedCount}, ошибок ${latestAudit.failedCount}`
      : "Сверка еще не выполнялась",
    ...(topReasons.length > 0 ? ["", "Частые причины отказа:", ...topReasons] : []),
  ].join("\n"));
}

function trimTelegramMessage(text: string): string {
  return text.length <= 3900 ? text : `${text.slice(0, 3890)}\n...`;
}
