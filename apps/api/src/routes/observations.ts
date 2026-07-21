import type { FastifyInstance } from "fastify";
import { Prisma, prisma } from "@amb/db";
import {
  FILTER_REJECTION_LABELS,
  QUEUE_NAMES,
  type FilterRejectionReason,
} from "@amb/shared";
import { z } from "zod";
import { enqueue } from "../lib/queues.js";

const sourceSchema = z.enum(["AUTO_RIA", "OLX", "RST", "CARS_UA", "AUTOMOTO", "MOCK"]);
const summaryQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(24 * 30).default(24),
});
const replayBodySchema = z.object({
  lookbackHours: z.number().int().min(1).max(24 * 8).default(48),
  limit: z.number().int().min(1).max(2_000).default(1_000),
});

export async function observationsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/observations/summary", async (req, reply) => {
    const parsed = summaryQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const cutoff = new Date(Date.now() - parsed.data.hours * 60 * 60 * 1000);
    const observationWindow = {
      normalizedData: { not: Prisma.JsonNull },
      OR: [{ publishedAt: { gte: cutoff } }, { firstSeenAt: { gte: cutoff } }],
    } satisfies Prisma.SourceSeenListingWhereInput;

    const [observed, byDecision, bySource, matchedWithoutListing, latestAudit, rejectedRows, listingsWithoutNotification, legacyWithoutSnapshot] = await Promise.all([
      prisma.sourceSeenListing.count({ where: observationWindow }),
      prisma.sourceSeenListing.groupBy({
        by: ["decision"],
        where: observationWindow,
        _count: { _all: true },
      }),
      prisma.sourceSeenListing.groupBy({
        by: ["source"],
        where: observationWindow,
        _count: { _all: true },
      }),
      prisma.sourceSeenListing.count({
        where: {
          ...observationWindow,
          listingId: null,
          decision: { in: ["MATCHED", "DISPATCHED", "NOTIFIED"] },
        },
      }),
      prisma.completenessAudit.findFirst({ orderBy: { startedAt: "desc" } }),
      prisma.sourceSeenListing.findMany({
        where: { ...observationWindow, decision: "REJECTED" },
        select: { rejectionReasons: true },
        take: 5_000,
      }),
      prisma.listing.count({
        where: {
          firstSeenAt: { gte: cutoff },
          telegramNotifications: { none: { status: { in: ["SENT", "UPDATED"] } } },
        },
      }),
      prisma.sourceSeenListing.count({
        where: {
          normalizedData: { equals: Prisma.DbNull },
          OR: [{ publishedAt: { gte: cutoff } }, { firstSeenAt: { gte: cutoff } }],
        },
      }),
    ]);

    const rejectionCounts = new Map<string, number>();
    for (const row of rejectedRows) {
      for (const reason of row.rejectionReasons) {
        rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + 1);
      }
    }

    return {
      hours: parsed.data.hours,
      cutoff,
      observed,
      byDecision: Object.fromEntries(byDecision.map((row) => [row.decision, row._count._all])),
      bySource: Object.fromEntries(bySource.map((row) => [row.source, row._count._all])),
      matchedWithoutListing,
      listingsWithoutNotification,
      legacyWithoutSnapshot,
      topRejectionReasons: [...rejectionCounts.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 10)
        .map(([reason, count]) => ({
          reason,
          label: FILTER_REJECTION_LABELS[reason as FilterRejectionReason] ?? reason,
          count,
        })),
      latestAudit,
    };
  });

  app.post("/observations/replay", async (req, reply) => {
    const parsed = replayBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    await enqueue(
      QUEUE_NAMES.OBSERVATION_REPLAY,
      "replay",
      { trigger: "MANUAL", ...parsed.data },
      { jobId: `manual-observation-replay-${Date.now()}` },
    );
    return reply.code(202).send({ ok: true, queued: true, ...parsed.data });
  });

  app.get<{ Params: { source: string; externalId: string } }>(
    "/observations/:source/:externalId",
    async (req, reply) => {
      const source = sourceSchema.safeParse(req.params.source);
      if (!source.success) return reply.code(400).send({ error: "Unknown source" });

      const observation = await prisma.sourceSeenListing.findUnique({
        where: {
          source_externalId: {
            source: source.data,
            externalId: req.params.externalId,
          },
        },
      });
      if (!observation) return reply.code(404).send({ error: "Observation not found" });

      return {
        observation,
        rejectionLabels: observation.rejectionReasons.map((reason) => ({
          reason,
          label: FILTER_REJECTION_LABELS[reason as FilterRejectionReason] ?? reason,
        })),
      };
    },
  );
}
