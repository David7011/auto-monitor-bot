import { createHash } from "node:crypto";
import { prisma } from "@amb/db";

export async function recordChallengeIncident(input: {
  sourceId: string;
  detector: string;
  responseStatus?: number;
  affectedUrl?: string;
  cooldownUntil: Date;
  limitedReason: string;
}): Promise<void> {
  await prisma.challengeIncident.updateMany({
    where: {
      sourceId: input.sourceId,
      status: { in: ["DETECTED", "COOLDOWN", "PROBE_PENDING", "RECOVERING"] },
    },
    data: {
      status: "REPEATED",
      resolution: "Проверка источника повторно встретила защитную страницу",
    },
  });

  await prisma.challengeIncident.create({
    data: {
      sourceId: input.sourceId,
      detector: input.detector,
      responseStatus: input.responseStatus,
      affectedUrlHash: input.affectedUrl ? hashUrl(input.affectedUrl) : null,
      cooldownUntil: input.cooldownUntil,
      status: "COOLDOWN",
      metadataRedacted: {
        limitedReason: input.limitedReason,
        hasAffectedUrl: Boolean(input.affectedUrl),
      },
    },
  });
}

export async function markChallengeProbePending(sourceId: string): Promise<void> {
  const incident = await prisma.challengeIncident.findFirst({
    where: { sourceId, status: { in: ["COOLDOWN", "REPEATED", "MANUAL_VERIFICATION_REQUIRED"] } },
    orderBy: { detectedAt: "desc" },
    select: { id: true },
  });
  if (!incident) return;

  await prisma.challengeIncident.update({
    where: { id: incident.id },
    data: {
      status: "PROBE_PENDING",
      probeAttempts: { increment: 1 },
      lastProbeAt: new Date(),
      resolution: "После паузы запущена одна безопасная проверка доступности",
    },
  });
}

export async function resolveChallengeIncidents(sourceId: string): Promise<number> {
  const recoveredAt = new Date();
  const result = await prisma.challengeIncident.updateMany({
    where: { sourceId, status: { not: "RESOLVED" } },
    data: {
      status: "RESOLVED",
      recoveredAt,
      resolution: "Источник снова отвечает без защитной страницы",
    },
  });
  return result.count;
}

function hashUrl(value: string): string {
  const url = redactQuerySecrets(value);
  return createHash("sha256").update(url).digest("hex");
}

function redactQuerySecrets(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|api/i.test(key)) url.searchParams.set(key, "redacted");
    }
    return url.toString();
  } catch {
    return value.replace(/([?&][^=]*(?:key|token|secret|api)[^=]*=)[^&]+/giu, "$1redacted");
  }
}
