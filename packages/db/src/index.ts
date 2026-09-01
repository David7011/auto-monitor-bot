import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { createHash } from "node:crypto";
import type { ErrorLogLevel, ListingSource } from "./generated/prisma/client.js";
import {
  closeDatabaseResources,
  databasePoolConfig,
  ResilientPgPool,
} from "./database-pool.js";
import {
  selectSourceSearchStateIdsToDelete,
  type SourceSearchStateHygieneOptions,
} from "@amb/shared";

const rootEnvPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..", ".env");
config({ path: rootEnvPath });

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const globalForPool = globalThis as unknown as { ambDatabasePool?: ResilientPgPool };

const databasePool = globalForPool.ambDatabasePool ?? new ResilientPgPool(
  databasePoolConfig(process.env.DATABASE_URL),
);

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg(databasePool),
    log: ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
  globalForPool.ambDatabasePool = databasePool;
}

export function getDatabasePoolDiagnostics() {
  return databasePool.diagnostics();
}

let databaseClosePromise: Promise<void> | null = null;

/**
 * Prisma does not own an externally supplied pg Pool, so `$disconnect()` alone
 * leaves warm idle sockets (and short-lived CLI processes) alive. Runtime
 * entrypoints must use this explicit owner-level shutdown.
 */
export function closeDatabase(): Promise<void> {
  databaseClosePromise ??= closeDatabaseResources(
    () => prisma.$disconnect(),
    () => databasePool.end(),
  );
  return databaseClosePromise;
}

export async function writeDeduplicatedLog(
  level: ErrorLogLevel,
  scope: string,
  message: string,
  details?: string,
): Promise<void> {
  const fingerprint = errorLogFingerprint(level, scope, message);
  const now = new Date();
  await prisma.errorLog.upsert({
    where: { fingerprint },
    create: {
      level,
      scope,
      message,
      details: details ?? null,
      fingerprint,
      occurrences: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    },
    update: {
      occurrences: { increment: 1 },
      lastSeenAt: now,
      details: details ?? undefined,
    },
  });
}

export function errorLogFingerprint(level: ErrorLogLevel, scope: string, message: string): string {
  return createHash("md5").update(`${level}\u001f${scope}\u001f${message}`).digest("hex");
}

/**
 * Serializes Telegram retention cleanup and the favorite callback across the
 * API and worker processes. The transaction-scoped lock is automatically
 * released on commit/rollback and cannot survive a crashed process.
 */
export async function acquireTelegramRetentionLock(
  tx: Prisma.TransactionClient,
  listingId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"telegram-retention:" + listingId}, 0))`;
}

export async function compactSourceSearchStates(
  options: SourceSearchStateHygieneOptions = {},
): Promise<{ deleted: number; planReady: boolean }> {
  const [enabledFilters, states] = await Promise.all([
    prisma.filter.findMany({ where: { enabled: true }, select: { id: true } }),
    prisma.sourceSearchState.findMany({
      where: options.source ? { source: options.source as ListingSource } : undefined,
      select: { id: true, source: true, fingerprint: true, filterIds: true, updatedAt: true },
    }),
  ]);
  const selection = selectSourceSearchStateIdsToDelete(
    states,
    new Set(enabledFilters.map((filter) => filter.id)),
    options,
  );
  if (selection.deleteIds.length === 0) return { deleted: 0, planReady: selection.planReady };

  const deleted = await prisma.sourceSearchState.deleteMany({ where: { id: { in: selection.deleteIds } } });
  return { deleted: deleted.count, planReady: selection.planReady };
}

export * from "./generated/prisma/client.js";
export * from "./database-pool.js";
