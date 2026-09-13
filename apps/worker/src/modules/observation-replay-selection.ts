import { Prisma } from "@amb/db";

/** Durable work has no age cutoff; only optional historical re-evaluation does. */
export function observationReplayWhere(cutoff: Date, revision: string, now = new Date()): Prisma.SourceSeenListingWhereInput {
  const retryBefore = new Date(now.getTime() - 5 * 60_000);
  return {
    normalizedData: { not: Prisma.DbNull },
    notifiedAt: null,
    telegramAcceptedAt: null,
    decision: { not: "NOTIFIED" },
    OR: [
      {
        listingId: null,
        decision: { in: ["PENDING", "FAILED", "MATCHED", "DISPATCHED"] },
        OR: [{ lastEvaluatedAt: null }, { lastEvaluatedAt: { lte: retryBefore } }],
      },
      {
        AND: [
          { OR: [{ decision: { in: ["REJECTED", "DUPLICATE"] } }, { evaluationNotes: { has: "SHADOW_MODE: production notification suppressed" } }] },
          { OR: [{ lastEvaluatedAt: null }, { lastEvaluatedAt: { lte: retryBefore } }] },
          { OR: [{ publishedAt: { gte: cutoff } }, { firstSeenAt: { gte: cutoff } }] },
          { OR: [{ filterRevision: null }, { filterRevision: { not: revision } }] },
          { OR: [{ listingId: null }, { evaluationNotes: { has: "SHADOW_MODE: production notification suppressed" } }] },
        ],
      },
    ],
  };
}
