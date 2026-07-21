import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import { createHash } from "node:crypto";
import type { ErrorLogLevel } from "./generated/prisma/client.js";

const rootEnvPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..", ".env");
config({ path: rootEnvPath });

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    log: ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
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

export * from "./generated/prisma/client.js";
