import { createHash } from "node:crypto";
import type { NormalizedListing } from "@amb/shared";
import { env } from "../env.js";
import { redisConnection } from "../lib/queues.js";

export async function claimHotListing(listing: NormalizedListing): Promise<string | null> {
  const identity = [listing.source, listing.externalId, listing.canonicalUrl].join("|");
  const digest = createHash("sha256").update(identity).digest("hex");
  const key = `listing-hot-claim:${digest}`;
  try {
    const result = await redisConnection.set(key, "1", "EX", env.HOT_DUPLICATE_TTL_SECONDS, "NX");
    return result === "OK" ? key : null;
  } catch {
    // PostgreSQL uniqueness remains the correctness boundary if Redis is unavailable.
    return `redis-unavailable:${digest}`;
  }
}

export async function releaseHotListingClaim(key: string): Promise<void> {
  if (key.startsWith("redis-unavailable:")) return;
  try {
    await redisConnection.del(key);
  } catch {
    // TTL guarantees eventual recovery even if Redis disappears during failure handling.
  }
}
