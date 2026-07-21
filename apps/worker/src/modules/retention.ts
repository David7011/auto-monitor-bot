import { prisma } from "@amb/db";
import { log } from "../lib/log.js";
import { env } from "../env.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runRetentionMaintenance(now = new Date()): Promise<void> {
  const [collectorRuns, errors, audits, observations] = await prisma.$transaction([
    prisma.collectorRun.deleteMany({
      where: { startedAt: { lt: new Date(now.getTime() - env.RETENTION_COLLECTOR_RUN_DAYS * DAY_MS) } },
    }),
    prisma.errorLog.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - env.RETENTION_ERROR_LOG_DAYS * DAY_MS) } },
    }),
    prisma.completenessAudit.deleteMany({
      where: { startedAt: { lt: new Date(now.getTime() - env.RETENTION_AUDIT_DAYS * DAY_MS) } },
    }),
    prisma.sourceSeenListing.deleteMany({
      where: { lastSeenAt: { lt: new Date(now.getTime() - env.RETENTION_OBSERVATION_DAYS * DAY_MS) } },
    }),
  ]);

  const deleted = collectorRuns.count + errors.count + audits.count + observations.count;
  if (deleted > 0) {
    await log.info(
      "retention",
      `Deleted ${collectorRuns.count} collector runs, ${errors.count} errors, ${audits.count} audits and ${observations.count} expired observations`,
    );
  }
}
