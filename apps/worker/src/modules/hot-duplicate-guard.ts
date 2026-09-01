import { createHash, randomUUID } from "node:crypto";
import type { NormalizedListing } from "@amb/shared";
import { env } from "../env.js";
import { redisConnection } from "../lib/queues.js";

export type HotDuplicateRedis = {
  set(key: string, value: string, expiryMode: "EX", ttlSeconds: number, condition: "NX"): Promise<unknown>;
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
};

export type HotListingClaim = {
  key: string;
  token: string | null;
};

export const RELEASE_HOT_LISTING_CLAIM_LUA = `
-- amb-release-hot-listing-claim-v1
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export function hotListingClaimKey(listing: NormalizedListing): string {
  const identity = [listing.source, listing.externalId, listing.canonicalUrl].join("|");
  const digest = createHash("sha256").update(identity).digest("hex");
  return `listing-hot-claim:${digest}`;
}

export async function claimHotListingWithRedis(
  listing: NormalizedListing,
  redis: HotDuplicateRedis,
  ttlSeconds: number,
  token = randomUUID(),
): Promise<HotListingClaim | null> {
  const key = hotListingClaimKey(listing);
  const result = await redis.set(key, token, "EX", ttlSeconds, "NX");
  return result === "OK" ? { key, token } : null;
}

export async function releaseHotListingClaimWithRedis(
  claim: HotListingClaim,
  redis: HotDuplicateRedis,
): Promise<void> {
  if (!claim.token) return;
  await redis.eval(RELEASE_HOT_LISTING_CLAIM_LUA, 1, claim.key, claim.token);
}

export async function claimHotListing(listing: NormalizedListing): Promise<HotListingClaim | null> {
  try {
    return await claimHotListingWithRedis(
      listing,
      redisConnection,
      env.HOT_DUPLICATE_TTL_SECONDS,
    );
  } catch {
    // PostgreSQL uniqueness remains the correctness boundary if Redis is unavailable.
    return { key: hotListingClaimKey(listing), token: null };
  }
}

export async function releaseHotListingClaim(claim: HotListingClaim): Promise<void> {
  if (!claim.token) return;
  try {
    await releaseHotListingClaimWithRedis(claim, redisConnection);
  } catch {
    // TTL guarantees eventual recovery even if Redis disappears during failure handling.
  }
}
