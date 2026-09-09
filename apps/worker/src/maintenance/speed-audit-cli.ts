import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, prisma } from "@amb/db";
import { summarizeJournalLatencies, summarizeMetric } from "@amb/shared";

// Read-only production evidence. Only this report file is written; no baseline,
// source state, queue or database record is modified by collecting measurements.
const args = process.argv.slice(2);
const option = (name: string): string | undefined => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const until = new Date(option("until") ?? Date.now());
const since = new Date(option("since") ?? until.getTime() - 24 * 60 * 60 * 1000);
if (!Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime()) || since >= until) {
  throw new Error("Supply a valid --since=ISO --until=ISO time interval");
}
const label = option("label");
if (label && !/^[a-z0-9_-]{1,60}$/u.test(label)) throw new Error("Invalid report label");

try {
  const [observations, runs, states, windows] = await Promise.all([
    prisma.sourceSeenListing.findMany({
      where: { firstSeenAt: { gte: since, lte: until }, discoveryLane: "REALTIME" },
      select: {
        source: true, externalId: true, url: true, decision: true, timestampConfidence: true,
        publishedAt: true, firstSeenAt: true, notifiedAt: true, requestStartedAt: true,
        firstByteAt: true, hotCandidateAt: true, journalPersistedAt: true, telegramAcceptedAt: true,
      },
      orderBy: { firstSeenAt: "asc" },
    }),
    prisma.collectorRun.findMany({
      where: { startedAt: { gte: since, lte: until } },
      select: { source: true, lane: true, status: true, startedAt: true, finishedAt: true, requestCount: true, pageCount: true, observedCount: true, newCount: true, coverageMetrics: true },
      orderBy: { startedAt: "asc" },
    }),
    prisma.sourceSearchState.findMany({
      select: { source: true, fingerprint: true, filterIds: true, coverageRecoveryPending: true, coverageRecoveryCutoffAt: true, lastSuccessfulScanAt: true, parserHealth: true },
    }),
    prisma.coverageRecoveryWindow.groupBy({ by: ["source", "status", "unresolvedReason"], _count: { _all: true } }),
  ]);
  const bySource = [...new Set([...observations.map((row) => row.source), ...runs.map((row) => row.source)])].sort().map((source) => {
    const sourceRows = observations.filter((row) => row.source === source);
    const accepted = sourceRows.filter((row) => row.telegramAcceptedAt && row.telegramAcceptedAt <= until);
    const precisePublication = accepted.filter((row) => row.timestampConfidence === "HIGH" && row.publishedAt && row.publishedAt <= row.firstSeenAt);
    const publicationMs = precisePublication.map((row) => row.telegramAcceptedAt!.getTime() - row.publishedAt!.getTime());
    return {
      source, observations: sourceRows.length, accepted: accepted.length,
      stages: summarizeJournalLatencies(sourceRows),
      sourcePublicationToTelegramAcceptanceMs: summarizeMetric(publicationMs),
      // Age cohort is explicit: recovery/old source timestamps must not look
      // like an ordinary fresh realtime detection-latency regression.
      newlyPublishedWithin15MinutesMs: summarizeMetric(publicationMs.filter((ms) => ms <= 15 * 60_000)),
      lanes: [...new Set(runs.filter((row) => row.source === source).map((row) => row.lane))].map((lane) => {
        const rows = runs.filter((row) => row.source === source && row.lane === lane);
        const successful = rows.filter((row) => row.finishedAt && ["SUCCESS", "LIMITED"].includes(row.status));
        const gaps = successful.slice(1).map((row, index) => row.startedAt.getTime() - successful[index]!.startedAt.getTime());
        return {
          lane, runs: rows.length, requests: rows.reduce((sum, row) => sum + row.requestCount, 0),
          pages: rows.reduce((sum, row) => sum + row.pageCount, 0),
          observed: rows.reduce((sum, row) => sum + row.observedCount, 0),
          new: rows.reduce((sum, row) => sum + row.newCount, 0),
          statuses: Object.fromEntries([...new Set(rows.map((row) => row.status))].map((status) => [status, rows.filter((row) => row.status === status).length])),
          durationMs: summarizeMetric(successful.map((row) => row.finishedAt!.getTime() - row.startedAt.getTime()).filter((ms) => ms >= 0)),
          successStartGapMs: summarizeMetric(gaps),
          latestCoverageMetrics: rows.at(-1)?.coverageMetrics,
        };
      }),
      examples: accepted.slice(-5).map((row) => ({
        externalId: row.externalId, url: row.url, timestampConfidence: row.timestampConfidence,
        publishedAt: row.publishedAt, requestStartedAt: row.requestStartedAt, firstByteAt: row.firstByteAt,
        hotCandidateAt: row.hotCandidateAt, journalPersistedAt: row.journalPersistedAt, telegramAcceptedAt: row.telegramAcceptedAt,
      })),
    };
  });
  const report = {
    collectedAt: new Date().toISOString(), since, until,
    measurement: "Source-reported publication / local detection -> Telegram API acceptance; client receipt/read is not observable via Bot API",
    bySource, states, recoveryWindows: windows,
  };
  if (label) {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
    const directory = path.join(projectRoot, ".runtime", "audit");
    await mkdir(directory, { recursive: true });
    const filename = path.join(directory, `${label}-${Date.now()}.json`);
    await writeFile(filename, JSON.stringify(report, null, 2), { flag: "wx" });
    console.log(`Report: ${filename}`);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await closeDatabase();
}
