import { closeDatabase, prisma } from "@amb/db";
import type { SourceSearchContext } from "../collectors/base.js";

// Read-only production evidence: never print credentials or listing payloads.
try {
  const sources = ["AUTO_RIA", "AUTOMOTO", "RST"] as const;
  for (const source of sources) {
    const state = await prisma.source.findUnique({ where: { source }, select: {
      source: true, enabled: true, status: true, pausedUntil: true,
      lastCheckedAt: true, lastError: true,
    } });
    const runs = await prisma.collectorRun.findMany({ where: { source }, orderBy: { startedAt: "desc" }, take: 5,
      select: { startedAt: true, finishedAt: true, status: true, lane: true, foundCount: true, newCount: true, matchedCount: true } });
    console.log(JSON.stringify({ state, runs }));
  }
  if (process.argv.includes("--probe-public")) {
    const { AutoRiaPublicCollector } = await import("../collectors/auto-ria-public.js");
    const { AutoMotoCollector } = await import("../collectors/automoto.js");
    const { closeSourceHttpClient } = await import("../collectors/source-http-client.js");
    try {
      for (const collector of [new AutoRiaPublicCollector(), new AutoMotoCollector()]) {
        const context: SourceSearchContext = {
          source: collector.source, categoryKey: "vehicle.car", categorySchemaVersion: 1,
          plannerVersion: 1, categoryCriteria: {}, unknownPolicy: "MAX_COVERAGE", shadowMode: true,
          fingerprint: "read-only-source-probe", filterIds: [], models: [], bodyTypes: [], fuelTypes: [],
          gearboxes: [], driveTypes: [], colors: [], regions: [], cities: [], keywords: [], excludeKeywords: [],
          freshnessMode: "ALL_TIME", initialWindowBehavior: "SKIP_EXISTING", maxInitialWindowNotifications: 0,
        };
        const result = await collector.collect(context, { id: "probe", fingerprint: context.fingerprint, knownExternalIds: new Set() }, {
          lane: "REALTIME", maxPages: 1, maxCandidates: 40, deadlineAt: new Date(Date.now() + 15_000),
        });
        console.log(JSON.stringify({ probe: collector.source, observed: result.observedCount,
          parsed: result.listings.length, requests: result.requestCount, limited: result.limited,
          captcha: result.captchaDetected ?? false, rateLimited: result.rateLimited ?? false,
          parserHealth: result.parserHealth, examples: result.listings.slice(0, 2).map((listing) => ({
            id: listing.externalId, publishedAt: listing.publishedAt, confidence: listing.timestampConfidence,
          })),
        }));
      }
    } finally { await closeSourceHttpClient(); }
  }
} finally { await closeDatabase(); }
