import { prisma } from "@amb/db";
import { log } from "../lib/log.js";
import { env } from "../env.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runRetentionMaintenance(now = new Date()): Promise<void> {
  const collectorCutoff = new Date(now.getTime() - env.RETENTION_COLLECTOR_RUN_DAYS * DAY_MS);
  const legacyObservationCutoff = new Date(now.getTime() - 7 * DAY_MS);
  const supersededStateCutoff = new Date(now.getTime() - 7 * DAY_MS);
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('auto-monitor-bot:retention'))`;
    const aggregated = await tx.$executeRaw`
      INSERT INTO "collector_run_hourly" (
        "id", "bucketAt", "source", "lane", "status", "runCount",
        "foundCount", "newCount", "recoveredCount", "requestCount", "observedCount",
        "matchedCount", "rejectedCount", "duplicateCount", "dispatchedCount",
        "totalDurationMs", "createdAt", "updatedAt"
      )
      SELECT
        md5(random()::text || clock_timestamp()::text || "source"::text || "lane"::text || "status"::text),
        date_trunc('hour', "startedAt"), "source", "lane", "status", COUNT(*)::integer,
        COALESCE(SUM("foundCount"), 0)::bigint,
        COALESCE(SUM("newCount"), 0)::bigint,
        COALESCE(SUM("recoveredCount"), 0)::bigint,
        COALESCE(SUM("requestCount"), 0)::bigint,
        COALESCE(SUM("observedCount"), 0)::bigint,
        COALESCE(SUM("matchedCount"), 0)::bigint,
        COALESCE(SUM("rejectedCount"), 0)::bigint,
        COALESCE(SUM("duplicateCount"), 0)::bigint,
        COALESCE(SUM("dispatchedCount"), 0)::bigint,
        COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE("finishedAt", "startedAt") - "startedAt")) * 1000), 0)::bigint,
        ${now}, ${now}
      FROM "collector_runs"
      WHERE "startedAt" < ${collectorCutoff}
      GROUP BY date_trunc('hour', "startedAt"), "source", "lane", "status"
      ON CONFLICT ("bucketAt", "source", "lane", "status") DO UPDATE SET
        "runCount" = "collector_run_hourly"."runCount" + EXCLUDED."runCount",
        "foundCount" = "collector_run_hourly"."foundCount" + EXCLUDED."foundCount",
        "newCount" = "collector_run_hourly"."newCount" + EXCLUDED."newCount",
        "recoveredCount" = "collector_run_hourly"."recoveredCount" + EXCLUDED."recoveredCount",
        "requestCount" = "collector_run_hourly"."requestCount" + EXCLUDED."requestCount",
        "observedCount" = "collector_run_hourly"."observedCount" + EXCLUDED."observedCount",
        "matchedCount" = "collector_run_hourly"."matchedCount" + EXCLUDED."matchedCount",
        "rejectedCount" = "collector_run_hourly"."rejectedCount" + EXCLUDED."rejectedCount",
        "duplicateCount" = "collector_run_hourly"."duplicateCount" + EXCLUDED."duplicateCount",
        "dispatchedCount" = "collector_run_hourly"."dispatchedCount" + EXCLUDED."dispatchedCount",
        "totalDurationMs" = "collector_run_hourly"."totalDurationMs" + EXCLUDED."totalDurationMs",
        "updatedAt" = EXCLUDED."updatedAt"
    `;
    const collectorRuns = await tx.collectorRun.deleteMany({ where: { startedAt: { lt: collectorCutoff } } });
    const errors = await tx.errorLog.deleteMany({
      where: { lastSeenAt: { lt: new Date(now.getTime() - env.RETENTION_ERROR_LOG_DAYS * DAY_MS) } },
    });
    const audits = await tx.completenessAudit.deleteMany({
      where: { startedAt: { lt: new Date(now.getTime() - env.RETENTION_AUDIT_DAYS * DAY_MS) } },
    });
    const observations = await tx.sourceSeenListing.deleteMany({
      where: {
        lastSeenAt: { lt: new Date(now.getTime() - env.RETENTION_OBSERVATION_DAYS * DAY_MS) },
        // Compact NOTIFIED rows are permanent dedupe tombstones. Their heavy
        // normalizedData is removed by listing retention, but the external ID
        // must survive so an old advert can never be sent again.
        decision: { not: "NOTIFIED" },
      },
    });
    const legacyObservations = await tx.$executeRaw`
      DELETE FROM "source_seen_listings"
      WHERE "normalizedData" IS NULL
        AND "decision" <> 'NOTIFIED'
        AND "createdAt" < ${legacyObservationCutoff}
    `;
    const supersededStates = await tx.$executeRaw`
      DELETE FROM "source_search_states" AS old_state
      WHERE old_state."updatedAt" < ${supersededStateCutoff}
        AND EXISTS (
          SELECT 1
          FROM "source_search_states" AS new_state
          WHERE new_state."source" = old_state."source"
            AND new_state."fingerprint" <> old_state."fingerprint"
            AND new_state."updatedAt" > old_state."updatedAt"
            AND new_state."filterIds" @> old_state."filterIds"
            AND old_state."filterIds" @> new_state."filterIds"
        )
    `;
    const orphanStates = await tx.$executeRaw`
      DELETE FROM "source_search_states" AS state
      WHERE NOT EXISTS (
        SELECT 1 FROM "filters" AS filter
        WHERE filter."enabled" = true AND filter."id" = ANY(state."filterIds")
      )
    `;
    return { aggregated, collectorRuns, errors, audits, observations, legacyObservations, supersededStates, orphanStates };
  }, { maxWait: 10_000, timeout: 120_000 });

  const deleted = result.collectorRuns.count + result.errors.count + result.audits.count + result.observations.count +
    result.legacyObservations + result.supersededStates + result.orphanStates;
  if (deleted > 0) {
    await log.info(
      "retention",
      `Compacted ${result.collectorRuns.count} collector runs into ${result.aggregated} hourly buckets; deleted ${result.errors.count} errors, ${result.audits.count} audits, ${result.observations.count} expired observations, ${result.legacyObservations} legacy observations, ${result.supersededStates} superseded search states and ${result.orphanStates} orphan search states`,
    );
  }
}
