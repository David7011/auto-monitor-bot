import assert from "node:assert/strict";
import { prisma } from "@amb/db";
import { AutoRiaPublicCollector } from "../../apps/worker/src/collectors/auto-ria-public.js";
import { sourceHttpClient } from "../../apps/worker/src/collectors/source-http-client.js";
import { buildSearchContextFromFilter, loadSourceSearchState, markSourceSearchSuccess } from "../../apps/worker/src/modules/source-search-plan.js";
import { env } from "../../apps/worker/src/env.js";

/** Called only by the isolated PostgreSQL/Redis acceptance entry point. */
export async function assertAutoRiaPublicRecovery(): Promise<void> {
  assert(process.env.AMB_PIPELINE_INTEGRATION_TEST === "1" && new URL(env.DATABASE_URL).pathname === "/amb_pipeline_test");
  const filter = await prisma.filter.create({ data: { name: "public recovery acceptance", sources: ["AUTO_RIA"] } });
  const context = buildSearchContextFromFilter("AUTO_RIA", filter);
  const initial = await loadSourceSearchState(context);
  const boundary = new Date(Date.now() - 3_600_000);
  await prisma.sourceSearchState.update({ where: { id: initial.id }, data: {
    initialSyncCompletedAt: boundary, lastSuccessfulScanAt: boundary, knownExternalIds: ["999999"] } });
  const opened = await markSourceSearchSuccess(context, await loadSourceSearchState(context), [], {
    initialSyncCompleted: true, lane: "REALTIME", autoRiaPublicOutage: true, parserHealth: "HEALTHY",
  });
  assert(opened.recoveryRequired && opened.outageDetected && opened.recoveryWindowId);
  const realtimeBoundary = (await loadSourceSearchState(context)).lastSuccessfulScanAt;
  const original = sourceHttpClient.text;
  const saved = env.AUTO_RIA_SAVED_SEARCH_URLS;
  env.AUTO_RIA_SAVED_SEARCH_URLS = "";
  const pages: number[] = [];
  sourceHttpClient.text = async url => {
    const page = Number(new URL(url).searchParams.get("page")); pages.push(page);
    const ids = page < 5 ? Array.from({ length: 20 }, (_, index) => 800000 + page * 20 + index) : [];
    return { requestId: "fixture", status: 200, classification: "SUCCESS", contentType: "text/html",
      body: ids.map(id => '"advertisementCard":' + JSON.stringify({ data: {
        id, type: "Auto", link: `/auto_test_${id}.html`, title: { content: "Toyota Camry 2018" },
      } })).join("\n") };
  };
  try {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await loadSourceSearchState(context);
      const result = await new AutoRiaPublicCollector().collect(context, state, {
        lane: "BACKFILL", recovery: true, maxPages: 3, maxCandidates: 100, deadlineAt: new Date(Date.now() + 10_000),
      });
      for (const listing of result.listings) {
        assert.equal(listing.timestampConfidence, "UNKNOWN");
        assert.equal(listing.freshnessFallback, "FIRST_SEEN");
        assert(!seen.has(listing.externalId), "Resume rediscovered a previously persisted ID");
        seen.add(listing.externalId);
      }
      await markSourceSearchSuccess(context, state, result.listings, {
        ...result, initialSyncCompleted: true, lane: "BACKFILL", newestFirstVerified: false,
      });
    }
    assert.equal(seen.size, 100, "Catch-up failed to discover all five pages");
    assert.deepEqual(pages, [0, 1, 2, 2, 3, 4, 4, 5]);
    const after = await loadSourceSearchState(context);
    assert.equal(after.coverageRecoveryPending, false);
    assert.equal(after.lastSuccessfulScanAt?.getTime(), realtimeBoundary?.getTime(), "Backfill moved realtime boundary");
    const window = await prisma.coverageRecoveryWindow.findUniqueOrThrow({ where: { id: opened.recoveryWindowId! } });
    assert.equal(window.status, "UNRESOLVED", "Public source cannot prove original publication coverage");
    assert.equal(window.verifiedAt, null);
    assert.equal(window.attemptCount, 3);
  } finally {
    sourceHttpClient.text = original;
    env.AUTO_RIA_SAVED_SEARCH_URLS = saved;
  }
}
