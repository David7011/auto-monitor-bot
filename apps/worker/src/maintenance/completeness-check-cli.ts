import { closeDatabase, prisma } from "@amb/db";
import {
  summarizeCompletenessFacts,
  type CompletenessIssueCode,
} from "../modules/completeness-contract.js";

type FactRow = { identity: string; detail: string | null };

const staleHours = boundedInteger(argumentValue("--stale-hours"), 1, 24 * 30, 24);
const sampleLimit = boundedInteger(argumentValue("--sample-limit"), 1, 500, 50);
const staleBefore = new Date(Date.now() - staleHours * 60 * 60 * 1000);

if (process.argv.includes("--apply")) {
  console.error("Refusing --apply: this checker is intentionally read-only; repair requires a separately reviewed tool.");
  process.exitCode = 2;
} else {
  try {
    const groups = await collectFacts(staleBefore, sampleLimit);
    const facts = groups.flatMap(({ code, rows }) => rows.map((row) => ({
      code,
      identity: row.identity,
      detail: row.detail ?? undefined,
    })));
    const summary = summarizeCompletenessFacts(facts);
    console.log(JSON.stringify({
      checkedAt: new Date().toISOString(),
      mode: "READ_ONLY",
      staleHours,
      sampleLimit,
      ok: summary.ok,
      impossibleCount: summary.impossibleCount,
      recoverableCount: summary.recoverableCount,
      findings: summary.findings,
    }, null, 2));
    if (summary.impossibleCount > 0) process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

async function collectFacts(stale: Date, limit: number): Promise<Array<{ code: CompletenessIssueCode; rows: FactRow[] }>> {
  return Promise.all([
    fact("KNOWN_ID_WITHOUT_OBSERVATION", prisma.$queryRaw<FactRow[]>`
      SELECT concat(state.source::text, ':', state.fingerprint, ':', ids."externalId") AS identity,
             'legacy/current continuity anchor has no journal row; retain as recovery evidence' AS detail
      FROM source_search_states state
      CROSS JOIN LATERAL unnest(state."knownExternalIds") AS ids("externalId")
      LEFT JOIN source_seen_listings seen
        ON seen.source = state.source AND seen."externalId" = ids."externalId"
      WHERE seen.id IS NULL
      ORDER BY state."updatedAt" DESC
      LIMIT ${limit}
    `),
    fact("LISTING_WITHOUT_OBSERVATION", prisma.$queryRaw<FactRow[]>`
      SELECT concat(listing.source::text, ':', listing."externalId") AS identity,
             concat('listingId=', listing.id) AS detail
      FROM listings listing
      LEFT JOIN source_seen_listings seen
        ON seen.source = listing.source AND seen."externalId" = listing."externalId"
      WHERE seen.id IS NULL
      ORDER BY listing."firstSeenAt" DESC
      LIMIT ${limit}
    `),
    fact("TELEGRAM_WITHOUT_LISTING", prisma.$queryRaw<FactRow[]>`
      SELECT notification.id AS identity, concat('listingId=', notification."listingId") AS detail
      FROM telegram_notifications notification
      LEFT JOIN listings listing ON listing.id = notification."listingId"
      WHERE listing.id IS NULL
      ORDER BY notification."createdAt" DESC
      LIMIT ${limit}
    `),
    fact("OBSERVATION_DANGLING_LISTING", prisma.$queryRaw<FactRow[]>`
      SELECT concat(seen.source::text, ':', seen."externalId") AS identity,
             concat('listingId=', seen."listingId") AS detail
      FROM source_seen_listings seen
      LEFT JOIN listings listing ON listing.id = seen."listingId"
      WHERE seen."listingId" IS NOT NULL AND listing.id IS NULL
        AND seen.decision <> 'DUPLICATE'
        AND NOT (seen.decision = 'NOTIFIED' AND (seen."telegramAcceptedAt" IS NOT NULL OR seen."notifiedAt" IS NOT NULL))
      ORDER BY seen."lastSeenAt" DESC
      LIMIT ${limit}
    `),
    fact("NOTIFIED_WITHOUT_ACCEPTED_NOTIFICATION", prisma.$queryRaw<FactRow[]>`
      SELECT concat(seen.source::text, ':', seen."externalId") AS identity,
             concat('listingId=', coalesce(seen."listingId", 'NULL'), '; notification=', coalesce(notification.status::text, 'NULL')) AS detail
      FROM source_seen_listings seen
      LEFT JOIN telegram_notifications notification ON notification."listingId" = seen."listingId"
      WHERE seen.decision = 'NOTIFIED'::"ObservationDecision"
        AND seen."telegramAcceptedAt" IS NULL
        AND seen."notifiedAt" IS NULL
        AND (seen."listingId" IS NULL OR notification."acceptedAt" IS NULL OR notification.status NOT IN ('SENT', 'UPDATED'))
      ORDER BY seen."lastSeenAt" DESC
      LIMIT ${limit}
    `),
    fact("DISPATCH_WITHOUT_NOTIFICATION_STATE", prisma.$queryRaw<FactRow[]>`
      SELECT concat(seen.source::text, ':', seen."externalId") AS identity,
             concat('decision=', seen.decision::text, '; listingId=', coalesce(seen."listingId", 'NULL')) AS detail
      FROM source_seen_listings seen
      LEFT JOIN listings listing ON listing.id = seen."listingId"
      LEFT JOIN telegram_notifications notification ON notification."listingId" = seen."listingId"
      WHERE seen."dispatchAttemptedAt" IS NOT NULL
        AND seen."dispatchAttemptedAt" < ${stale}
        AND seen.decision IN ('MATCHED', 'DISPATCHED')
        AND (seen."listingId" IS NULL OR listing."notificationMode" <> 'SHADOW')
        AND notification.id IS NULL
      ORDER BY seen."dispatchAttemptedAt" ASC
      LIMIT ${limit}
    `),
    fact("STALE_REPLAYABLE_OBSERVATION", prisma.$queryRaw<FactRow[]>`
      SELECT concat(seen.source::text, ':', seen."externalId") AS identity,
             concat('decision=', seen.decision::text, '; updatedAt=', seen."updatedAt"::text) AS detail
      FROM source_seen_listings seen
      WHERE seen.decision IN ('PENDING', 'FAILED', 'MATCHED', 'DISPATCHED')
        AND seen."updatedAt" < ${stale}
        AND NOT (seen.decision = 'MATCHED' AND EXISTS (
          SELECT 1 FROM listings listing WHERE listing.id = seen."listingId" AND listing."notificationMode" = 'SHADOW'
        ))
      ORDER BY seen."updatedAt" ASC
      LIMIT ${limit}
    `),
    fact("BOUNDARY_AHEAD_OF_INCOMPLETE_OBSERVATION", prisma.$queryRaw<FactRow[]>`
      SELECT DISTINCT concat(state.source::text, ':', state.fingerprint, ':', seen."externalId") AS identity,
             concat('boundary=', state."lastSuccessfulScanAt"::text, '; decision=', seen.decision::text) AS detail
      FROM source_search_states state
      JOIN source_seen_listings seen ON seen.source = state.source
      WHERE state."lastSuccessfulScanAt" IS NOT NULL
        AND seen."journalPersistedAt" <= state."lastSuccessfulScanAt"
        AND seen.decision IN ('PENDING', 'FAILED')
      ORDER BY identity
      LIMIT ${limit}
    `),
    fact("PENDING_STATE_WITHOUT_WINDOW", prisma.$queryRaw<FactRow[]>`
      SELECT concat(state.source::text, ':', state.fingerprint) AS identity,
             'coverageRecoveryPending=true but no PENDING window exists' AS detail
      FROM source_search_states state
      WHERE state."coverageRecoveryPending" = true
        AND NOT EXISTS (
          SELECT 1 FROM coverage_recovery_windows recovery
          WHERE recovery."sourceSearchStateId" = state.id AND recovery.status = 'PENDING'
        )
      ORDER BY state."updatedAt" DESC
      LIMIT ${limit}
    `),
    fact("PENDING_WINDOW_WITHOUT_STATE", prisma.$queryRaw<FactRow[]>`
      SELECT recovery.id AS identity,
             concat('stateId=', recovery."sourceSearchStateId") AS detail
      FROM coverage_recovery_windows recovery
      JOIN source_search_states state ON state.id = recovery."sourceSearchStateId"
      WHERE recovery.status = 'PENDING' AND state."coverageRecoveryPending" = false
      ORDER BY recovery."detectedAt" DESC
      LIMIT ${limit}
    `),
    fact("VERIFIED_WITHOUT_EVIDENCE", prisma.$queryRaw<FactRow[]>`
      SELECT recovery.id AS identity,
             concat('method=', coalesce(recovery."verificationMethod"::text, 'NULL'), '; verifiedRunId=', coalesce(recovery."verifiedRunId", 'NULL')) AS detail
      FROM coverage_recovery_windows recovery
      WHERE recovery.status = 'VERIFIED'
        AND (
          recovery."verifiedAt" IS NULL
          OR recovery."verifiedRunId" IS NULL
          OR recovery."verificationMethod" IS NULL
          OR recovery."lastAttemptAt" IS NULL
          OR (recovery."verificationMethod" = 'CUTOFF' AND (recovery."oldestObservedAt" IS NULL OR recovery."oldestObservedAt" > recovery."requiredCutoffAt"))
        )
      ORDER BY recovery."detectedAt" DESC
      LIMIT ${limit}
    `),
  ]);
}

async function fact(code: CompletenessIssueCode, rows: Promise<FactRow[]>) {
  return { code, rows: await rows };
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function boundedInteger(value: string | undefined, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
