import type { FastifyInstance } from "fastify";
import { prisma } from "@amb/db";
import { boundedIntegerQuery, cursorQuery } from "../lib/query-validation.js";

async function getRecentListings(limit: number, cursor?: string) {
  const rows = await prisma.listing.findMany({
    orderBy: [{ firstSeenAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      vehicleChecks: { orderBy: { createdAt: "desc" }, take: 1 },
      marketPriceEstimate: true,
      telegramNotifications: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  const hasMore = rows.length > limit;
  const listings = hasMore ? rows.slice(0, limit) : rows;
  return { listings, nextCursor: hasMore ? listings.at(-1)?.id ?? null : null };
}

export async function listingsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { limit?: string; cursor?: string } }>("/listings", async (req, reply) => {
    const limit = boundedIntegerQuery(req.query.limit, { fallback: 50, max: 200 });
    if (limit == null) return reply.code(400).send({ error: "limit must be an integer between 1 and 200" });
    const cursor = cursorQuery(req.query.cursor);
    if (cursor === null) return reply.code(400).send({ error: "cursor is invalid" });
    return getRecentListings(limit, cursor);
  });

  app.get<{ Querystring: { limit?: string; cursor?: string } }>("/listings/recent", async (req, reply) => {
    const limit = boundedIntegerQuery(req.query.limit, { fallback: 50, max: 200 });
    if (limit == null) return reply.code(400).send({ error: "limit must be an integer between 1 and 200" });
    const cursor = cursorQuery(req.query.cursor);
    if (cursor === null) return reply.code(400).send({ error: "cursor is invalid" });
    return getRecentListings(limit, cursor);
  });

  app.get<{ Params: { id: string } }>("/listings/:id", async (req, reply) => {
    const listing = await prisma.listing.findUnique({
      where: { id: req.params.id },
      include: {
        vehicleChecks: { orderBy: { createdAt: "desc" } },
        marketPriceEstimate: true,
        telegramNotifications: { orderBy: { createdAt: "desc" } },
        matches: { include: { filter: true } },
      },
    });
    if (!listing) return reply.code(404).send({ error: "Listing not found" });
    return { listing };
  });
}
