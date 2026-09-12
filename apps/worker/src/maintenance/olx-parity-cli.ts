import { closeDatabase, prisma } from "@amb/db";
import { OlxCollector } from "../collectors/olx.js";
import { buildSourceSearchPlan, loadSourceSearchState } from "../modules/source-search-plan.js";
import { olxParityPermission } from "../modules/olx-parity-policy.js";
import { env } from "../env.js";

try {
  const [source, incident] = await Promise.all([
    prisma.source.findUnique({ where: { source: "OLX" } }),
    prisma.challengeIncident.findFirst({
      where: { source: { source: "OLX" } },
      orderBy: { detectedAt: "desc" },
      select: { detectedAt: true, cooldownUntil: true },
    }),
  ]);
  if (!source) throw new Error("OLX source row is missing");
  const permission = olxParityPermission({
    sourceStatus: source.status,
    pausedUntil: source.pausedUntil,
    incidentDetectedAt: incident?.detectedAt,
    incidentCooldownUntil: incident?.cooldownUntil,
    coolingSeconds: env.OLX_PROTECTION_COOLING_SECONDS,
  });
  if (!permission.allowed) {
    throw new Error(`OLX parity safely refused before network access: ${permission.reason}`);
  }

  const sampledAt = new Date();
  const contexts = await buildSourceSearchPlan("OLX");
  if (contexts.length === 0) throw new Error("No active OLX search context is configured");
  const collector = new OlxCollector();
  const observedIds = new Set<string>();
  const metrics: Record<string, unknown>[] = [];

  for (const context of contexts) {
    const persistedState = await loadSourceSearchState(context);
    const state = {
      ...persistedState,
      lastRegionalCoverageAt: undefined,
      lastHtmlCoverageAt: undefined,
      htmlCoveragePausedUntil: undefined,
      lastPrivateCoverageAt: undefined,
    };
    const result = await collector.collect(context, state, {
      lane: "MANUAL",
      maxPages: 1,
      maxCandidates: 500,
      deadlineAt: new Date(Date.now() + 30_000),
    });
    if (result.rateLimited || result.captchaDetected) {
      throw new Error(`OLX parity probe was protected (${result.detector ?? result.limitedReason ?? "unknown"})`);
    }
    for (const id of result.scannedExternalIds ?? result.listings.map((listing) => listing.externalId)) observedIds.add(id);
    if (result.coverageMetrics) metrics.push(result.coverageMetrics);
  }

  let missing = await missingDetectionIds([...observedIds]);
  if (missing.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    missing = await missingDetectionIds(missing);
  }
  if (missing.length > 0) {
    throw new Error(`OLX parity failed: ${missing.length} public feed advert(s) are absent from the observation journal: ${missing.slice(0, 20).join(", ")}`);
  }

  const durable = await prisma.sourceSeenListing.findMany({
    where: { source: "OLX", externalId: { in: [...observedIds] } },
    select: {
      externalId: true,
      firstObservedChannel: true,
      firstObservedTarget: true,
      journalPersistedAt: true,
    },
  });
  const channelCounts = Object.fromEntries([...new Set(durable.map((row) => row.firstObservedChannel ?? "LEGACY_UNATTRIBUTED"))]
    .map((channel) => [channel, durable.filter((row) => (row.firstObservedChannel ?? "LEGACY_UNATTRIBUTED") === channel).length]));
  const notFastFeed = durable.filter((row) => !["OLX_PUBLIC_API", "OLX_PUBLIC_HTML"].includes(row.firstObservedChannel ?? ""));
  const durableLagMs = durable.map((row) => Math.max(
    0,
    (row.journalPersistedAt?.getTime() ?? sampledAt.getTime()) - sampledAt.getTime(),
  ));
  console.log(`OLX parity passed: all ${observedIds.size} directly observed advert IDs have durable journal rows.`);
  console.log(JSON.stringify({
    sampledAt: sampledAt.toISOString(),
    observedCount: observedIds.size,
    channelCounts,
    notFastFeedCount: notFastFeed.length,
    notFastFeed: notFastFeed.slice(0, 20).map((row) => ({
      externalId: row.externalId,
      channel: row.firstObservedChannel,
      target: row.firstObservedTarget,
    })),
    controlToDurableMs: {
      definition: "0 when already durable before control sample; otherwise journalPersistedAt - sample start",
      max: durableLagMs.length > 0 ? Math.max(...durableLagMs) : null,
    },
    metrics,
  }, null, 2));
} finally {
  await closeDatabase();
}

async function missingDetectionIds(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const known = await prisma.sourceSeenListing.findMany({
    where: { source: "OLX", externalId: { in: ids } },
    select: { externalId: true },
  });
  const knownIds = new Set(known.map((item) => item.externalId));
  return ids.filter((id) => !knownIds.has(id));
}
