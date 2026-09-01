import { closeDatabase, prisma } from "@amb/db";
import { OlxCollector } from "../collectors/olx.js";
import { buildSourceSearchPlan, loadSourceSearchState } from "../modules/source-search-plan.js";

try {
  const contexts = await buildSourceSearchPlan("OLX");
  if (contexts.length === 0) throw new Error("No active OLX search context is configured");
  const collector = new OlxCollector();
  const observedIds = new Set<string>();
  const knownStateIds = new Set<string>();
  const metrics: Record<string, unknown>[] = [];

  for (const context of contexts) {
    const persistedState = await loadSourceSearchState(context);
    for (const id of persistedState.knownExternalIds) knownStateIds.add(id);
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

  let missing = await missingDetectionIds([...observedIds], knownStateIds);
  if (missing.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    for (const context of contexts) {
      const refreshedState = await loadSourceSearchState(context);
      for (const id of refreshedState.knownExternalIds) knownStateIds.add(id);
    }
    missing = await missingDetectionIds(missing, knownStateIds);
  }
  if (missing.length > 0) {
    throw new Error(`OLX parity failed: ${missing.length} public feed advert(s) are absent from the observation journal: ${missing.slice(0, 20).join(", ")}`);
  }

  console.log(`OLX parity passed: all ${observedIds.size} directly observed advert IDs exist in search state or the journal.`);
  console.log(JSON.stringify(metrics));
} finally {
  await closeDatabase();
}

async function missingDetectionIds(ids: string[], knownStateIds: Set<string>): Promise<string[]> {
  if (ids.length === 0) return [];
  const known = await prisma.sourceSeenListing.findMany({
    where: { source: "OLX", externalId: { in: ids } },
    select: { externalId: true },
  });
  const knownIds = new Set(known.map((item) => item.externalId));
  return ids.filter((id) => !knownStateIds.has(id) && !knownIds.has(id));
}
