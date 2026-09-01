import { closeDatabase, prisma } from "@amb/db";
import {
  createTelegramLatencyReport,
  TELEGRAM_LATENCY_MIN_SAMPLE_SIZE,
} from "../modules/telegram-latency-report.js";

// v2 deliberately cannot reuse the legacy firstSeenAt/notifiedAt baseline:
// only rows carrying both exact stage timestamps may decide the SLO.
const BASELINE_KEY = "telemetry.telegram.acceptance-baseline.v2";
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const now = new Date();

function validDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function minimumSampleSize(): number {
  const argument = rawArgs.find((value) => value.startsWith("--min-samples="));
  if (!argument) return TELEGRAM_LATENCY_MIN_SAMPLE_SIZE;
  const value = Number(argument.slice("--min-samples=".length));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("--min-samples must be a positive integer");
  }
  return value;
}

function formatMetric(value: number | null): string {
  return value == null ? "нет данных" : `${value} мс`;
}

try {
  const requiredSamples = minimumSampleSize();
  if (args.has("--mark-baseline")) {
    await prisma.setting.upsert({
      where: { key: BASELINE_KEY },
      update: { value: now.toISOString() },
      create: { key: BASELINE_KEY, value: now.toISOString() },
    });
  }

  const baselineSetting = await prisma.setting.findUnique({ where: { key: BASELINE_KEY } });
  const baselineAt = validDate(baselineSetting?.value);
  const rollingStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const queryStart = baselineAt && baselineAt > rollingStart ? baselineAt : rollingStart;
  const observations = await prisma.sourceSeenListing.findMany({
    where: {
      discoveryLane: "REALTIME",
      journalPersistedAt: { gte: queryStart, lte: now },
      telegramAcceptedAt: { not: null },
    },
    orderBy: { journalPersistedAt: "asc" },
    select: { source: true, journalPersistedAt: true, telegramAcceptedAt: true },
  });
  const report = createTelegramLatencyReport({
    now,
    baselineAt,
    minimumSampleSize: requiredSamples,
    samples: observations.flatMap((row) => row.journalPersistedAt && row.telegramAcceptedAt
      ? [{
        source: row.source,
        journalPersistedAt: row.journalPersistedAt,
        telegramAcceptedAt: row.telegramAcceptedAt,
      }]
      : []),
  });

  if (args.has("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const statusLabel = report.status === "READY"
      ? "готова достоверная 24-часовая оценка"
      : report.status === "LOW_SAMPLE"
        ? "24-часовое окно собрано, но выборка пока мала"
        : "идёт сбор 24-часового окна";
    console.log(`Telegram durable journal -> API acceptance p95: ${statusLabel}`);
    console.log(`Baseline: ${report.baselineAt ?? "не зафиксирован"}`);
    console.log(`Возраст baseline: ${report.baselineAgeHours ?? 0} ч; окно: ${report.windowHours} ч`);
    console.log(`Выборка: ${report.sampleSize}/${report.minimumSampleSize}; p50: ${formatMetric(report.latencyMs.p50)}; p95: ${formatMetric(report.latencyMs.p95)}; max: ${formatMetric(report.latencyMs.max)}`);
    for (const source of report.bySource) {
      console.log(`${source.source}: n=${source.sampleSize}, p50=${formatMetric(source.latencyMs.p50)}, p95=${formatMetric(source.latencyMs.p95)}`);
    }
    if (report.status === "COLLECTING") {
      console.log("SLO p95 <= 3000 мс: итог будет рассчитан после полных 24 часов.");
    } else if (report.status === "LOW_SAMPLE") {
      console.log(`SLO p95 <= 3000 мс: итог не рассчитывается до минимальной выборки; нужно ещё ${report.remainingSamples}.`);
    } else {
      console.log(`SLO p95 <= 3000 мс: ${report.target.passed ? "PASS" : "FAIL"}`);
    }
  }
} finally {
  await closeDatabase();
}
