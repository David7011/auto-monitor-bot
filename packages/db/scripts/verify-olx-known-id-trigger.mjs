import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import pg from "pg";

config({ path: new URL("../../../.env", import.meta.url) });

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) throw new Error("DATABASE_URL is required");
const connectionString = rawUrl.replace(/[?&]schema=public(?:&|$)/u, (match) => match.endsWith("&") ? "?" : "");
const client = new pg.Client({ connectionString });
const contender = new pg.Client({ connectionString });
const id = `olx-trigger-check-${randomUUID()}`;
const retentionLockKey = `telegram-retention:${id}`;

await client.connect();
await contender.connect();
try {
  await client.query("BEGIN");
  await client.query(
    `
      INSERT INTO "listings" (
        "id", "source", "externalId", "url", "canonicalUrl", "photoUrls",
        "duplicateReasons", "firstSeenAt", "lastSeenAt", "status", "createdAt", "updatedAt"
      ) VALUES ($1, 'OLX', $2, $3, $3, ARRAY[]::text[], ARRAY[]::text[], NOW(), NOW(), 'SENT', NOW(), NOW())
    `,
    [id, id, `https://integration.invalid/${id}`],
  );
  await client.query(
    `
      INSERT INTO "telegram_notifications" (
        "id", "listingId", "chatId", "messageId", "status", "sentAt",
        "favoritedAt", "retainUntil", "createdAt", "updatedAt"
      ) VALUES ($1, $1, 'integration-chat', 'integration-message', 'SENT', NOW(), NOW(), NOW() + INTERVAL '10 days', NOW(), NOW())
    `,
    [id],
  );
  const favoriteBefore = await client.query(
    `SELECT "favoritedAt", "retainUntil", status::text AS status FROM "telegram_notifications" WHERE id = $1`,
    [id],
  );
  await client.query(
    `
      INSERT INTO "source_search_states" (
        "id", "source", "fingerprint", "knownExternalIds",
        "lastSuccessfulScanAt", "updatedAt"
      )
      SELECT $1, 'OLX', $2, array_agg('trigger-test-' || value ORDER BY value), NOW(), NOW()
      FROM generate_series(1, 1999) AS value
    `,
    [id, id],
  );
  await client.query(
    `
      UPDATE "source_search_states"
      SET "knownExternalIds" = array_append("knownExternalIds", 'trigger-test-2000'),
          "updatedAt" = NOW()
      WHERE "id" = $1
    `,
    [id],
  );
  const result = await client.query(
    `
      SELECT
        cardinality("knownExternalIds") AS known_count,
        cardinality("coverageAnchorExternalIds") AS anchor_count,
        "coverageRecoveryPending" AS recovery_pending,
        "coverageRecoveryCutoffAt" IS NOT NULL AS has_cutoff,
        "knownIdsResetAt" IS NOT NULL AS has_reset_time
      FROM "source_search_states"
      WHERE "id" = $1
    `,
    [id],
  );
  const row = result.rows[0];
  const favoriteAfter = await client.query(
    `SELECT "favoritedAt", "retainUntil", status::text AS status FROM "telegram_notifications" WHERE id = $1`,
    [id],
  );
  if (
    Number(row?.known_count) !== 0
    || Number(row?.anchor_count) !== 50
    || row?.recovery_pending !== true
    || row?.has_cutoff !== true
    || row?.has_reset_time !== true
    || !favoriteAfter.rows[0]?.favoritedAt
    || !favoriteAfter.rows[0]?.retainUntil
    || favoriteAfter.rows[0]?.status !== "SENT"
    || favoriteAfter.rows[0]?.favoritedAt?.getTime() !== favoriteBefore.rows[0]?.favoritedAt?.getTime()
    || favoriteAfter.rows[0]?.retainUntil?.getTime() !== favoriteBefore.rows[0]?.retainUntil?.getTime()
  ) {
    throw new Error(`OLX known-ID trigger verification failed: ${JSON.stringify(row)}`);
  }
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [retentionLockKey],
  );
  await contender.query("BEGIN");
  await contender.query("SET LOCAL lock_timeout = '200ms'");
  let lockWasBlocked = false;
  try {
    await contender.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [retentionLockKey],
    );
  } catch (error) {
    lockWasBlocked = error?.code === "55P03";
  }
  if (!lockWasBlocked) throw new Error("Telegram retention advisory lock did not serialize concurrent transactions");

  await client.query("ROLLBACK");
  await contender.query("ROLLBACK");
  await contender.query("BEGIN");
  await contender.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [retentionLockKey],
  );
  await contender.query("ROLLBACK");
  console.log(
    "DB behavior verified transactionally: OLX 2000-ID reset clears IDs, preserves a real favorite row, and Telegram retention lock serializes cleanup",
  );
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await contender.query("ROLLBACK").catch(() => undefined);
  await client.end();
  await contender.end();
}
