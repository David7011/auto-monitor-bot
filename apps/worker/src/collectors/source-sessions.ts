import { env } from "../env.js";
import { redisConnection } from "../lib/queues.js";
import { log } from "../lib/log.js";

export const SOURCE_SESSION_REDIS_KEY = "session:";

/**
 * Harvested browser sessions per source (full Cookie header values).
 *
 * Pattern proven by the RST clearance relay: bots are held in verification
 * loops while a human-passed session opens the site. A solver (or a manual
 * pass) stores the session jar here; collectors replay it on every request.
 * Absent session changes nothing — requests go out exactly as before.
 */
export function sourceSessionRedisKey(source: string): string {
  return `${SOURCE_SESSION_REDIS_KEY}${source}`;
}

function sourceSessionEnvFallback(source: string): string {
  if (source === "OLX") return env.OLX_SESSION_COOKIE ?? "";
  if (source === "AUTO_RIA") return env.AUTO_RIA_SESSION_COOKIE ?? "";
  if (source === "RST") return env.RST_CF_CLEARANCE ?? "";
  return "";
}

export function normalizeSessionCookie(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  return value ? value : null;
}

type SessionCacheEntry = { value: string | null; expiresAt: number };
const sessionCache = new Map<string, SessionCacheEntry>();
const SESSION_CACHE_TTL_MS = 60_000;
const SESSION_FAILURE_TTL_MS = 10_000;

export function invalidateSourceSessionCache(source?: string): void {
  if (source) sessionCache.delete(source);
  else sessionCache.clear();
}

export async function getSourceSessionCookie(source: string): Promise<string | null> {
  const now = Date.now();
  const cached = sessionCache.get(source);
  if (cached && cached.expiresAt > now) return cached.value;
  const fallback = normalizeSessionCookie(sourceSessionEnvFallback(source));
  try {
    const fromRedis = normalizeSessionCookie(await redisConnection.get(sourceSessionRedisKey(source)));
    const value = fromRedis ?? fallback;
    sessionCache.set(source, { value, expiresAt: now + SESSION_CACHE_TTL_MS });
    return value;
  } catch (error) {
    sessionCache.set(source, { value: fallback, expiresAt: now + SESSION_FAILURE_TTL_MS });
    await log.warn(
      "collector",
      `Source session Redis read failed for ${source}, using env fallback: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ).catch(() => undefined);
    return fallback;
  }
}

export async function storeSourceSessionCookie(source: string, cookie: string): Promise<boolean> {
  const normalized = normalizeSessionCookie(cookie);
  if (!normalized) return false;
  try {
    await redisConnection.set(sourceSessionRedisKey(source), normalized);
    sessionCache.set(source, { value: normalized, expiresAt: Date.now() + SESSION_CACHE_TTL_MS });
    return true;
  } catch (error) {
    await log.warn(
      "collector",
      `Source session Redis write failed for ${source}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ).catch(() => undefined);
    return false;
  }
}

/** Merges a session cookie into request headers without touching the rest. */
export function withSessionCookie(
  headers: Record<string, string>,
  sessionCookie: string | null,
): Record<string, string> {
  if (!sessionCookie) return headers;
  return { ...headers, Cookie: sessionCookie };
}
