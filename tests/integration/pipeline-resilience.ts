import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { prisma, compactSourceSearchStates } from "@amb/db";
import { QUEUE_NAMES, olxRecoveryAttemptGeneration, summarizeMetric, type NormalizedListing } from "@amb/shared";
import { fetchOlxApiFeed, isAdsResult } from "../../apps/worker/src/collectors/olx-feed.js";
import { selectOlxCandidates } from "../../apps/worker/src/collectors/olx.js";
import { closeSourceHttpClient } from "../../apps/worker/src/collectors/source-http-client.js";
import { closeQueues, getQueue } from "../../apps/worker/src/lib/queues.js";
import { configureTelegramApiRootForIntegrationTest, sendListingLink, stageListingForFlash, createTelegramFlashBundle, sendTelegramFlashBundle } from "../../apps/worker/src/modules/telegram-service.js";
import { recordPendingObservation, recordPendingObservations } from "../../apps/worker/src/modules/observation-journal.js";
import { checkDuplicate, findStrongDuplicate } from "../../apps/worker/src/modules/duplicate-guard.js";
import {
  buildSourceSearchPlan,
  buildSearchContextFromFilter,
  loadSourceSearchState,
  markSourceSearchSuccess,
} from "../../apps/worker/src/modules/source-search-plan.js";
import { processListingDetected } from "../../apps/worker/src/processors/listing-detected.js";
import { processTelegramSend } from "../../apps/worker/src/processors/telegram.js";

type TelegramMode = "SUCCESS" | "FAIL" | "STOP_DB_AFTER_ACCEPT";

const pgCtl = requiredEnv("AMB_TEST_PG_CTL");
const psql = requiredEnv("AMB_TEST_PSQL");
const pgData = requiredEnv("AMB_TEST_PG_DATA");
const pgLog = requiredEnv("AMB_TEST_PG_LOG");
const redisServer = requiredEnv("AMB_TEST_REDIS_SERVER");
const redisCli = requiredEnv("AMB_TEST_REDIS_CLI");
const redisConfig = requiredEnv("AMB_TEST_REDIS_CONFIG");
const redisPort = Number(requiredEnv("AMB_TEST_REDIS_PORT"));
const expectedIds = ["100001", "100002", "100003", "100004", "100005", "100006"];
const olxRequests = new Map<string, number>();
const telegramDeliveries = new Map<string, number>();
let telegramMode: TelegramMode = "SUCCESS";
let stopDatabaseOnNextTelegram = false;
let fakeRoot = "";

const fakeServer = createServer(async (request, response) => {
  try {
    await routeFakeRequest(request, response);
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, description: errorMessage(error) }));
  }
});

async function main(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    fakeServer.once("error", reject);
    fakeServer.listen(0, "127.0.0.1", () => resolve());
  });
  const address = fakeServer.address();
  if (!address || typeof address === "string") throw new Error("Fake HTTP server did not expose a TCP port");
  fakeRoot = `http://127.0.0.1:${address.port}`;
  configureTelegramApiRootForIntegrationTest(fakeRoot);

  const checks: string[] = [];
  let dbHotPathBenchmark: Awaited<ReturnType<typeof benchmarkDbHotPath>> | undefined;
  try {
    progress("reset and seed");
    await resetDatabase();
    await seedCatchAllFilter();

    progress("database hot-path benchmark");
    dbHotPathBenchmark = await benchmarkDbHotPath();
    checks.push("A/B database hot path: legacy redundant read + possible duplicate versus optimized durable upsert state + strong duplicate only");

    progress("category shadow isolation and promotion");
    await assertCategoryShadowIsolation();
    checks.push("durable shadow blocks direct/replayed card and flash; live reevaluation promotes once");

    progress("durable unresolved recovery window");
    await assertDurableUnresolvedRecoveryWindow();
    checks.push("unreachable boundary -> durable UNRESOLVED; ACK remains UNRESOLVED; restart preserves state");

    progress("category recovery isolation and degraded parser");
    await assertCategoryRecoveryIsolation();
    checks.push("foreign shard write rejected; degraded parser cannot verify cutoff; cleanup retains recovery evidence");

    progress("concurrent recovery state writers");
    await assertConcurrentRecoveryWritersSerialize();
    checks.push("two stale worker snapshots serialize through PostgreSQL row locking without losing anchors, cutoff or attempt evidence");

    await assertLegacyShardRekey();
    checks.push("legacy car re-key preserves state identity, cutoff, anchors and UNRESOLVED foreign key");

    progress("healthy pipeline");
    const healthy = await fetchKnownListing("100001");
    await recordPendingObservations([healthy], "REALTIME");
    await processListingDetected({ listing: healthy, discoveryLane: "REALTIME", bypassHotClaim: true });
    await assertSent("100001");
    await assertStageTimestamps("100001");
    checks.push("healthy OLX -> request/first-byte/hot/journal/Telegram timestamps");

    progress("Telegram endpoint failure");
    const telegramFailure = await fetchKnownListing("100004");
    await recordPendingObservations([telegramFailure], "REALTIME");
    telegramMode = "FAIL";
    await processListingDetected({ listing: telegramFailure, discoveryLane: "REALTIME", bypassHotClaim: true });
    await assertRecoverable("100004", ["RETRY_PENDING"]);
    await assertTelegramQueueContains("100004");
    telegramMode = "SUCCESS";
    await recoverTelegramForExternalId("100004");
    await assertSent("100004");
    checks.push("Telegram HTTP failure -> RETRY_PENDING + BullMQ fallback -> sent");

    progress("prepare PostgreSQL fault states");
    await fetchKnownListing("100002");
    await recordPendingObservations([await fetchKnownListing("100003")], "REALTIME");
    const dbAfterTelegram = await fetchKnownListing("100005");
    await recordPendingObservations([dbAfterTelegram], "REALTIME");
    telegramMode = "FAIL";
    await processListingDetected({ listing: dbAfterTelegram, discoveryLane: "REALTIME", bypassHotClaim: true });
    await assertRecoverable("100003");
    await assertRecoverable("100005", ["RETRY_PENDING"]);

    progress("Redis producer failure");
    const redisFailure = await fetchKnownListing("100006");
    stopRedis();
    await expectFailure(() => dispatchThroughDurableQueue(redisFailure), "Redis after observation journal");
    await assertRecoverable("100006", []);
    startRedis();
    await waitForRedis();
    telegramMode = "SUCCESS";
    await processListingDetected({ listing: redisFailure, discoveryLane: "REALTIME", bypassHotClaim: true });
    await assertSent("100006");
    checks.push("Redis producer loss -> prompt rejection + PENDING journal -> sent after recovery");

    progress("database failures before and after journal");
    stopPostgres();
    await runChild("--probe-db-before-journal", false);
    await runChild("--probe-db-after-journal", false);
    startPostgres();
    checks.push("PostgreSQL loss before journal -> deterministic OLX source replay remains observable");
    checks.push("PostgreSQL loss after journal -> PENDING normalized snapshot remains recoverable");

    progress("database failure after Telegram acceptance");
    telegramMode = "STOP_DB_AFTER_ACCEPT";
    stopDatabaseOnNextTelegram = true;
    await within(recoverTelegramForExternalId("100005").catch(() => undefined), 7_000, undefined);
    startPostgres();
    telegramMode = "SUCCESS";
    checks.push("DB loss after Telegram accepts -> PROCESSING/RETRY_PENDING lease remains recoverable");

    assertFinalInvariantViaFreshConnection();
    console.log(JSON.stringify({
      result: "PASS",
      invariant: "every deterministic OLX advert is NOTIFIED or remains in an explicit recoverable state",
      expectedIds,
      olxRequests: Object.fromEntries(olxRequests),
      telegramDeliveries: Object.fromEntries(telegramDeliveries),
      dbHotPathBenchmark,
      checks,
    }, null, 2));
  } finally {
    progress("cleanup");
    telegramMode = "SUCCESS";
    if (!(await within(databaseAvailable(), 2_000, false))) startPostgres();
    if (!(await redisAvailable())) startRedis();
    await within(Promise.allSettled([closeQueues(), closeSourceHttpClient(), prisma.$disconnect()]), 5_000, []);
    fakeServer.close();
    fakeServer.closeAllConnections();
    await within(once(fakeServer, "close").catch(() => undefined), 2_000, undefined);
  }
}

async function benchmarkDbHotPath(iterations = 40) {
  const legacyMs: number[] = [];
  const optimizedMs: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    for (const variant of index % 2 === 0 ? ["legacy", "optimized"] : ["optimized", "legacy"]) {
      const externalId = `benchmark-${variant}-${index}`;
      const listing: NormalizedListing = {
        source: "OLX",
        externalId,
        url: `https://example.test/${externalId}`,
        canonicalUrl: `https://example.test/${externalId}`,
        title: `Benchmark vehicle ${index}`,
        year: 2019,
        priceOriginal: 12_345 + index,
        priceNormalized: 300 + index,
        photoUrls: [],
        firstSeenAt: new Date(),
        raw: { benchmark: true },
      };
      const startedAt = performance.now();
      if (variant === "legacy") {
        await recordPendingObservations([listing], "REALTIME");
        await prisma.sourceSeenListing.findUnique({
          where: { source_externalId: { source: listing.source, externalId } },
          select: { decision: true, listingId: true, matchedFilterIds: true },
        });
        await checkDuplicate(listing);
        legacyMs.push(performance.now() - startedAt);
      } else {
        await recordPendingObservation(listing, "REALTIME");
        await findStrongDuplicate(listing);
        optimizedMs.push(performance.now() - startedAt);
      }
    }
  }
  return {
    iterations,
    legacySqlRoundTrips: 4,
    optimizedSqlRoundTrips: 2,
    legacyMs: summarizeMetric(legacyMs),
    optimizedMs: summarizeMetric(optimizedMs),
  };
}

async function assertDurableUnresolvedRecoveryWindow(): Promise<void> {
  const context = (await buildSourceSearchPlan("OLX"))[0];
  if (!context) throw new Error("OLX integration context was not created");
  const initialState = await loadSourceSearchState(context);
  const boundary = new Date(Date.now() - 60 * 60 * 1_000);
  const cutoff = new Date(boundary.getTime() - 5 * 60 * 1_000);
  await prisma.sourceSearchState.update({
    where: { id: initialState.id },
    data: {
      initialSyncCompletedAt: new Date(),
      lastSuccessfulScanAt: boundary,
      coverageRecoveryPending: true,
      coverageRecoveryCutoffAt: cutoff,
      lastPage: 21,
    },
  });
  const window = await prisma.coverageRecoveryWindow.create({
    data: {
      source: "OLX",
      sourceSearchStateId: initialState.id,
      reason: "OFFLINE_WINDOW",
      persistedBoundaryAt: boundary,
      requiredCutoffAt: cutoff,
    },
  });
  const state = await loadSourceSearchState(context);
  const result = await markSourceSearchSuccess(context, state, [], {
    initialSyncCompleted: true,
    lane: "BACKFILL",
    pageCount: 21,
    requestCount: 21,
    observedCount: 1_050,
    coverageVerified: false,
    coverageUnresolvedReason: "PUBLIC_OFFSET_CAP",
    coverageAttemptGeneration: olxRecoveryAttemptGeneration({ pageSize: 50, maxOffset: 1_000 }),
    runId: "integration-unreachable-boundary",
  });
  if (!result.recoveryUnresolved || result.recoveryVerified || result.recoveryRequired) {
    throw new Error(`Unexpected recovery transition: ${JSON.stringify(result)}`);
  }
  const unresolved = await prisma.coverageRecoveryWindow.findUniqueOrThrow({ where: { id: window.id } });
  if (unresolved.status !== "UNRESOLVED" || unresolved.unresolvedReason !== "PUBLIC_OFFSET_CAP") {
    throw new Error(`Unreachable window was not persisted as UNRESOLVED: ${unresolved.status}/${unresolved.unresolvedReason}`);
  }
  const persistedState = await prisma.sourceSearchState.findUniqueOrThrow({ where: { id: initialState.id } });
  if (persistedState.coverageRecoveryPending) throw new Error("UNRESOLVED window remained eligible for automatic recovery");

  await prisma.coverageRecoveryWindow.update({
    where: { id: window.id },
    data: { acknowledgedAt: new Date(), acknowledgedBy: "integration-test" },
  });
  await prisma.$disconnect();
  const afterRestart = await prisma.coverageRecoveryWindow.findUniqueOrThrow({ where: { id: window.id } });
  if (afterRestart.status !== "UNRESOLVED" || !afterRestart.acknowledgedAt) {
    throw new Error("ACK or reconnect changed the durable unresolved state");
  }
}

async function assertCategoryShadowIsolation(): Promise<void> {
  const filter = await prisma.filter.create({ data: {
    name: "Laptop shadow", categoryKey: "electronics.laptop", sources: ["OLX"],
    freshnessMode: "ALL_TIME", shadowMode: true, categoryCriteria: { minRamGb: 16 },
  } });
  const listing: NormalizedListing = { ...probeListing("100007"), categoryKey: "electronics.laptop",
    categoryAttributes: {}, title: "HP EliteBook integration 100007", brand: "HP", model: "EliteBook",
    priceOriginal: 18000, currencyOriginal: "UAH", priceNormalized: 450 };
  const result = await processListingDetected({ listing, filterIds: [filter.id], bypassHotClaim: true });
  assert(result.outcome === "SHADOWED" && result.listingId, "Laptop shadow did not persist a match");
  const row = await prisma.sourceSeenListing.findUniqueOrThrow({ where: { source_externalId: { source: "OLX", externalId: listing.externalId } } });
  assert(row.listingId === result.listingId && row.dispatchAttemptedAt === null, "Shadow journal lost identity or claimed dispatch");
  await prisma.$disconnect();
  await sendListingLink(result.listingId);
  await processTelegramSend({ listingId: result.listingId });
  assert(!await stageListingForFlash(result.listingId, "shadow-bundle"), "Shadow entered flash staging");
  assert(!await createTelegramFlashBundle("shadow-bundle", [result.listingId, "missing"]), "Shadow entered a flash bundle");
  await prisma.telegramFlashBundle.create({ data: {
    id: "legacy-shadow-bundle", chatId: "1", listingIds: [result.listingId], lastText: "integration 100007 must not escape",
  } });
  assert((await sendTelegramFlashBundle("legacy-shadow-bundle")).length === 0, "Legacy queued flash released a shadow listing");
  const legacyFlash = await prisma.telegramFlashBundle.findUniqueOrThrow({ where: { id: "legacy-shadow-bundle" } });
  assert(legacyFlash.lastErrorCode === "SHADOW_SUPPRESSED", "Legacy shadow flash was not visibly suppressed");
  assert(!telegramDeliveries.has("100007"), "Shadow escaped to Telegram");
  assert(await prisma.telegramNotification.count({ where: { listingId: result.listingId } }) === 0, "Shadow created a notification retry row");
  await prisma.filter.update({ where: { id: filter.id }, data: { shadowMode: false } });
  await delay(2100); // Deliberately expire the production filter cache.
  await processListingDetected({ listing, filterIds: [filter.id], bypassHotClaim: true });
  await sendListingLink(result.listingId);
  const notification = await prisma.telegramNotification.findUniqueOrThrow({ where: { listingId: result.listingId } });
  assert(telegramDeliveries.get("100007") === 1, "Promotion/replay must deliver exactly once on a successful API response");
  assert(notification.lastText?.includes("не подтверждена"), "UNKNOWN notification lost its provisional warning");
  await prisma.filter.update({ where: { id: filter.id }, data: { enabled: false } });
}

async function assertCategoryRecoveryIsolation(): Promise<void> {
  const carFilter = await prisma.filter.findFirstOrThrow({ where: { categoryKey: "vehicle.car" } });
  const carContext = buildSearchContextFromFilter("OLX", carFilter);
  const laptopContext = buildSearchContextFromFilter("OLX", { ...carFilter, categoryKey: "electronics.laptop" });
  const car = await loadSourceSearchState(carContext);
  const laptop = await loadSourceSearchState(laptopContext);
  const cutoff = new Date(Date.now() - 3600000);
  await prisma.sourceSearchState.update({ where: { id: laptop.id }, data: {
    coverageRecoveryPending: true, coverageRecoveryCutoffAt: cutoff, knownExternalIds: ["laptop-tail"],
  } });
  await expectFailure(() => markSourceSearchSuccess(carContext, laptop, [], { initialSyncCompleted: true }), "foreign shard recovery write");
  await markSourceSearchSuccess(laptopContext, await loadSourceSearchState(laptopContext), [], {
    initialSyncCompleted: true, lane: "BACKFILL", parserHealth: "DEGRADED", coverageVerified: true,
    cutoffReached: true, coverageVerificationMethod: "CUTOFF", oldestObservedAt: cutoff, cutoff,
  });
  const after = await prisma.sourceSearchState.findUniqueOrThrow({ where: { id: laptop.id } });
  assert(after.lastCompletedCutoff === null && after.coverageRecoveryPending, "Degraded parser advanced proven coverage");
  assert(after.parserHealth === "DEGRADED", "Parser degradation was not durable");
  const untouched = await prisma.sourceSearchState.findUniqueOrThrow({ where: { id: car.id } });
  assert(!untouched.knownExternalIds.includes("laptop-tail"), "Laptop anchors entered car state");
  const completedHistoryState = await prisma.sourceSearchState.create({
    data: { source: "OLX", fingerprint: "completed-history", filterIds: [], query: {} },
  });
  const completedHistoryWindow = await prisma.coverageRecoveryWindow.create({
    data: {
      source: "OLX",
      sourceSearchStateId: completedHistoryState.id,
      reason: "OFFLINE_WINDOW",
      status: "VERIFIED",
      persistedBoundaryAt: new Date(cutoff.getTime() + 300_000),
      requiredCutoffAt: cutoff,
      verifiedAt: new Date(),
      verificationMethod: "CUTOFF",
    },
  });
  const beforeWindows = await prisma.coverageRecoveryWindow.count();
  const replacement = await prisma.sourceSearchState.create({ data: { source: "OLX", fingerprint: "cleanup-replacement", filterIds: [carFilter.id], query: {} } });
  await compactSourceSearchStates({ source: "OLX", currentFingerprints: [replacement.fingerprint], preserveStateId: replacement.id });
  assert(await prisma.coverageRecoveryWindow.count() === beforeWindows, "Planner cleanup deleted durable recovery history");
  assert(await prisma.sourceSearchState.count({ where: { id: laptop.id } }) === 1, "Planner cleanup deleted pending category recovery");
  assert(await prisma.sourceSearchState.count({ where: { id: completedHistoryState.id } }) === 1,
    "Planner cleanup deleted a state owning completed recovery history");
  assert(await prisma.coverageRecoveryWindow.count({ where: { id: completedHistoryWindow.id } }) === 1,
    "Cascade deleted a completed recovery proof");
}

async function assertConcurrentRecoveryWritersSerialize(): Promise<void> {
  const filter = await prisma.filter.findFirstOrThrow({ where: { categoryKey: "vehicle.car" } });
  const context = buildSearchContextFromFilter("OLX", {
    ...filter,
    regions: ["concurrency-test-region"],
    cities: [],
  });
  const staleSnapshot = await loadSourceSearchState(context);
  const cutoff = new Date(Date.now() - 3 * 60 * 60 * 1_000);
  const boundary = new Date(cutoff.getTime() + 5 * 60 * 1_000);
  await prisma.sourceSearchState.update({
    where: { id: staleSnapshot.id },
    data: {
      initialSyncCompletedAt: boundary,
      lastSuccessfulScanAt: boundary,
      coverageRecoveryPending: true,
      coverageRecoveryCutoffAt: cutoff,
      knownExternalIds: ["race-anchor"],
    },
  });
  const window = await prisma.coverageRecoveryWindow.create({
    data: {
      source: "OLX",
      sourceSearchStateId: staleSnapshot.id,
      reason: "OFFLINE_WINDOW",
      persistedBoundaryAt: boundary,
      requiredCutoffAt: cutoff,
    },
  });
  const sharedStaleState = await loadSourceSearchState(context);
  const first = {
    ...probeListing("race-worker-a"),
    publishedAt: new Date(boundary.getTime() - 60_000),
  };
  const second = {
    ...probeListing("race-worker-b"),
    publishedAt: new Date(boundary.getTime() - 120_000),
  };

  await Promise.all([
    markSourceSearchSuccess(context, sharedStaleState, [first], {
      initialSyncCompleted: true,
      lane: "BACKFILL",
      pageCount: 1,
      requestCount: 1,
      observedCount: 1,
      oldestObservedAt: first.publishedAt,
      backfillResumePage: 2,
      runId: "race-worker-a",
    }),
    markSourceSearchSuccess(context, sharedStaleState, [second], {
      initialSyncCompleted: true,
      lane: "BACKFILL",
      pageCount: 2,
      requestCount: 2,
      observedCount: 1,
      oldestObservedAt: second.publishedAt,
      backfillResumePage: 3,
      runId: "race-worker-b",
    }),
  ]);

  const persisted = await prisma.sourceSearchState.findUniqueOrThrow({ where: { id: staleSnapshot.id } });
  assert(persisted.coverageRecoveryPending, "Concurrent incomplete attempts incorrectly closed recovery");
  assert(persisted.coverageRecoveryCutoffAt?.getTime() === cutoff.getTime(), "Concurrent writers narrowed the durable cutoff");
  assert(persisted.knownExternalIds.includes("race-worker-a"), "First worker anchor was lost");
  assert(persisted.knownExternalIds.includes("race-worker-b"), "Second worker anchor was lost");
  const evidence = await prisma.coverageRecoveryWindow.findUniqueOrThrow({ where: { id: window.id } });
  assert(evidence.status === "PENDING", "Concurrent incomplete attempts changed recovery status");
  assert(evidence.attemptCount === 2, `Expected two serialized attempts, received ${evidence.attemptCount}`);
  assert(evidence.pageCount === 3 && evidence.requestCount === 3 && evidence.observedCount === 2,
    "Concurrent attempt evidence was overwritten instead of accumulated");
}

async function assertLegacyShardRekey(): Promise<void> {
  const filter = await prisma.filter.findFirstOrThrow({ where: { categoryKey: "vehicle.car" } });
  const context = buildSearchContextFromFilter("OLX", { ...filter, regions: ["legacy-test-region"], cities: [] });
  const cutoff = new Date(Date.now() - 7200000);
  const legacy = await prisma.sourceSearchState.create({ data: {
    source: "OLX", fingerprint: "legacy-category-less", filterIds: [filter.id],
    query: { source: "OLX", regions: context.regions, cities: [] },
    initialSyncCompletedAt: cutoff, lastSuccessfulScanAt: cutoff, lastCompletedCutoff: cutoff,
    lastPage: 7, knownExternalIds: ["legacy-tail"], coverageAnchorExternalIds: ["frozen-tail"],
  } });
  const window = await prisma.coverageRecoveryWindow.create({ data: {
    source: "OLX", sourceSearchStateId: legacy.id, reason: "OFFLINE_WINDOW", status: "UNRESOLVED",
    persistedBoundaryAt: cutoff, requiredCutoffAt: cutoff, unresolvedReason: "PUBLIC_OFFSET_CAP", unresolvedAt: new Date(),
  } });
  const state = await loadSourceSearchState(context);
  assert(state.id === legacy.id, "Planner copied a legacy scope instead of preserving its durable identity");
  assert(state.lastCompletedCutoff?.getTime() === cutoff.getTime() && state.lastPage === 7, "Planner lost legacy cutoff/cursor");
  assert(state.knownExternalIds.has("legacy-tail") && state.coverageAnchorExternalIds.has("frozen-tail"), "Planner lost legacy anchors");
  const preserved = await prisma.coverageRecoveryWindow.findUniqueOrThrow({ where: { id: window.id } });
  assert(preserved.sourceSearchStateId === state.id && preserved.status === "UNRESOLVED", "Planner detached or verified legacy recovery");
}

const probeMode = process.argv[2];
const entrypoint = probeMode ? runProbe(probeMode) : main();
void entrypoint.then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);

async function runProbe(mode: string): Promise<void> {
  if (process.env.AMB_TEST_FAKE_ROOT) fakeRoot = process.env.AMB_TEST_FAKE_ROOT;
  const externalId = mode === "--probe-db-before-journal" ? "100002"
    : mode === "--probe-db-after-journal" ? "100003"
      : "100005";
  if (mode === "--probe-db-after-telegram") {
    configureTelegramApiRootForIntegrationTest(requiredEnv("AMB_TEST_FAKE_ROOT"));
    await recoverTelegramForExternalId(externalId);
  } else if (mode === "--probe-db-after-journal") {
    await processListingDetected({ listing: probeListing(externalId), discoveryLane: "REALTIME", bypassHotClaim: true });
  } else if (mode === "--probe-db-before-journal") {
    await recordPendingObservations([probeListing(externalId)], "REALTIME");
  } else {
    throw new Error(`Unknown probe mode: ${mode}`);
  }
}

async function routeFakeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", fakeRoot);
  if (url.pathname === "/olx/api/v1/offers") {
    const id = url.searchParams.get("id") ?? "";
    if (!expectedIds.includes(id)) return json(response, 404, { error: "unknown deterministic advert" });
    olxRequests.set(id, (olxRequests.get(id) ?? 0) + 1);
    const now = new Date(Date.now() - Number(id.slice(-2)) * 1_000).toISOString();
    return json(response, 200, {
      data: [{
        id,
        title: `Volkswagen Golf integration ${id}`,
        description: "Deterministic integration advert",
        url: `${fakeRoot}/olx/d/${id}`,
        created_time: now,
        last_refresh_time: now,
        location: { city: { name: "Kyiv" }, region: { name: "Kyiv" } },
        photos: [],
        params: [
          { key: "price", value: { value: 10_000 + Number(id.slice(-2)), currency: "USD" } },
          { key: "motor_year", value: { key: "2020", label: "2020" } },
          { key: "model", value: { key: "golf", label: "Golf" } },
          { key: "motor_mileage_thou", value: { key: "100", label: "100" } },
        ],
      }],
    });
  }
  if (/^\/bottest-token\/(?:sendMessage|editMessageText|editMessageReplyMarkup)$/u.test(url.pathname)) {
    const body = await readBody(request);
    const listingId = body.match(/integration\s+(10000\d)/u)?.[1] ?? "unknown";
    if (telegramMode === "FAIL") {
      return json(response, 503, { ok: false, error_code: 503, description: "integration Telegram outage" });
    }
    telegramDeliveries.set(listingId, (telegramDeliveries.get(listingId) ?? 0) + 1);
    if (telegramMode === "STOP_DB_AFTER_ACCEPT" && stopDatabaseOnNextTelegram) {
      stopDatabaseOnNextTelegram = false;
      stopPostgres();
    }
    return json(response, 200, {
      ok: true,
      result: { message_id: 700_000 + Number(listingId.slice(-3) || 0), date: Math.floor(Date.now() / 1000), chat: { id: 1, type: "private" } },
    });
  }
  return json(response, 404, { ok: false, description: "fake endpoint not found" });
}

async function fetchKnownListing(id: string): Promise<NormalizedListing> {
  const url = `${fakeRoot}/olx/api/v1/offers?id=${id}`;
  const feed = await fetchOlxApiFeed(url, true, 3_000, "OLX_PUBLIC_API", `integration:${id}`, "REALTIME");
  if (!isAdsResult(feed)) throw new Error(`Fake OLX feed failed for ${id}`);
  const selected = selectOlxCandidates(feed.ads, {
    now: new Date(),
    knownExternalIds: new Set(),
    maxCandidates: 1,
    observationChannel: feed.channel,
    observationTarget: feed.observationTarget,
    requestStartedAt: feed.requestStartedAt,
    firstByteAt: feed.firstByteAt,
    bodyReceivedAt: feed.bodyReceivedAt,
    parsedAt: feed.parsedAt,
  });
  const listing = selected.listings[0];
  if (!listing) throw new Error(`Fake OLX advert ${id} did not normalize`);
  listing.hotCandidateAt = new Date();
  return listing;
}

async function dispatchThroughDurableQueue(listing: NormalizedListing): Promise<void> {
  await recordPendingObservations([listing], "REALTIME");
  await getQueue(QUEUE_NAMES.LISTING_DETECTED).add("detected", { listing, discoveryLane: "REALTIME" }, {
    jobId: `integration-redis-${listing.externalId}`,
    removeOnComplete: true,
  });
}

async function recoverTelegramForExternalId(externalId: string): Promise<void> {
  const listing = await prisma.listing.findUniqueOrThrow({
    where: { source_externalId: { source: "OLX", externalId } },
    select: { id: true },
  });
  await processTelegramSend({ listingId: listing.id });
}

async function assertTelegramQueueContains(externalId: string): Promise<void> {
  const listing = await prisma.listing.findUniqueOrThrow({
    where: { source_externalId: { source: "OLX", externalId } },
    select: { id: true },
  });
  const job = await getQueue(QUEUE_NAMES.TELEGRAM_SEND).getJob(`telegram-send-${listing.id}`);
  assert(Boolean(job), `Telegram fallback job is missing for ${externalId}`);
}

async function assertSent(externalId: string): Promise<void> {
  const row = await pipelineRow(externalId);
  assert(row?.decision === "NOTIFIED", `${externalId} observation is ${row?.decision ?? "missing"}, expected NOTIFIED`);
  assert(["SENT", "UPDATED"].includes(row.notificationStatus ?? ""), `${externalId} notification is ${row.notificationStatus ?? "missing"}`);
}

async function assertStageTimestamps(externalId: string): Promise<void> {
  const row = await pipelineRow(externalId);
  assert(Boolean(row?.requestStartedAt), `${externalId} has no requestStartedAt`);
  assert(Boolean(row?.firstByteAt), `${externalId} has no firstByteAt`);
  assert(Boolean(row?.bodyReceivedAt), `${externalId} has no bodyReceivedAt`);
  assert(Boolean(row?.parsedAt), `${externalId} has no parsedAt`);
  assert(Boolean(row?.hotCandidateAt), `${externalId} has no hotCandidateAt`);
  assert(Boolean(row?.journalPersistedAt), `${externalId} has no journalPersistedAt`);
  assert(Boolean(row?.telegramAcceptedAt), `${externalId} has no telegramAcceptedAt`);
  assert(Boolean(row?.notificationAcceptedAt), `${externalId} notification has no acceptedAt`);
  const stages = [
    row!.requestStartedAt!,
    row!.firstByteAt!,
    row!.bodyReceivedAt!,
    row!.parsedAt!,
    row!.hotCandidateAt!,
    row!.journalPersistedAt!,
    row!.telegramAcceptedAt!,
  ].map((value) => value.getTime());
  assert(stages.every((value, index) => index === 0 || value >= stages[index - 1]!), `${externalId} stage timestamps are not monotonic`);
  assert(row!.telegramAcceptedAt!.getTime() === row!.notificationAcceptedAt!.getTime(), `${externalId} Telegram acceptance timestamps diverged`);
}

async function assertRecoverable(externalId: string, notificationStatuses: string[] = []): Promise<void> {
  const row = await pipelineRow(externalId);
  assert(Boolean(row?.hasSnapshot), `${externalId} has no durable normalized snapshot`);
  const terminal = row?.decision === "NOTIFIED" && ["SENT", "UPDATED"].includes(row.notificationStatus ?? "");
  const localRecovery = ["PENDING", "FAILED", "MATCHED", "DISPATCHED"].includes(row?.decision ?? "")
    && (!row?.notificationStatus || ["PENDING", "FLASH_PENDING", "PROCESSING", "RETRY_PENDING", "FAILED"].includes(row.notificationStatus));
  assert(terminal || localRecovery, `${externalId} is neither sent nor locally recoverable: ${JSON.stringify(row)}`);
  if (notificationStatuses.length > 0) {
    assert(notificationStatuses.includes(row?.notificationStatus ?? ""), `${externalId} notification state ${row?.notificationStatus} is not one of ${notificationStatuses.join(", ")}`);
  }
}

function assertFinalInvariantViaFreshConnection(): void {
  const databaseUrl = new URL(requiredEnv("DATABASE_URL"));
  const query = `
    SELECT seen."externalId", seen.decision::text, COALESCE(notification.status::text, '')
    FROM "source_seen_listings" seen
    LEFT JOIN "telegram_notifications" notification ON notification."listingId" = seen."listingId"
    WHERE seen.source = 'OLX' AND seen."externalId" IN ('100001','100003','100004','100005','100006')
    ORDER BY seen."externalId"`;
  const result = spawnSync(psql, [
    "-h", databaseUrl.hostname,
    "-p", databaseUrl.port,
    "-U", decodeURIComponent(databaseUrl.username),
    "-d", databaseUrl.pathname.slice(1),
    "--tuples-only", "--no-align", "--field-separator=|", `--command=${query}`,
  ], { windowsHide: true, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(`Fresh invariant query failed: ${result.stderr || result.stdout}`);
  const rows = new Map(result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => {
    const [externalId, decision, notification] = line.split("|");
    return [externalId, { decision, notification }] as const;
  }));
  for (const externalId of ["100001", "100004", "100006"]) {
    const row = rows.get(externalId);
    assert(row?.decision === "NOTIFIED" && ["SENT", "UPDATED"].includes(row.notification ?? ""), `${externalId} is not confirmed sent`);
  }
  const journalRecovery = rows.get("100003");
  assert(["PENDING", "FAILED", "MATCHED", "DISPATCHED"].includes(journalRecovery?.decision ?? ""), "100003 has no journal recovery state");
  const telegramRecovery = rows.get("100005");
  assert(["PROCESSING", "RETRY_PENDING", "FAILED"].includes(telegramRecovery?.notification ?? ""), "100005 has no Telegram recovery state");
  assert((olxRequests.get("100002") ?? 0) >= 1, "100002 is not observable in the deterministic OLX replay fixture");
}

async function pipelineRow(externalId: string) {
  const rows = await prisma.$queryRaw<Array<{
    decision: string;
    has_snapshot: boolean;
    notification_status: string | null;
    request_started_at: Date | null;
    first_byte_at: Date | null;
    body_received_at: Date | null;
    parsed_at: Date | null;
    hot_candidate_at: Date | null;
    journal_persisted_at: Date | null;
    telegram_accepted_at: Date | null;
    notification_accepted_at: Date | null;
  }>>`
    SELECT seen.decision::text AS decision,
           seen."normalizedData" IS NOT NULL AS has_snapshot,
           notification.status::text AS notification_status,
           seen."requestStartedAt" AS request_started_at,
           seen."firstByteAt" AS first_byte_at,
           seen."bodyReceivedAt" AS body_received_at,
           seen."parsedAt" AS parsed_at,
           seen."hotCandidateAt" AS hot_candidate_at,
           seen."journalPersistedAt" AS journal_persisted_at,
           seen."telegramAcceptedAt" AS telegram_accepted_at,
           notification."acceptedAt" AS notification_accepted_at
    FROM "source_seen_listings" seen
    LEFT JOIN "telegram_notifications" notification ON notification."listingId" = seen."listingId"
    WHERE seen.source = 'OLX' AND seen."externalId" = ${externalId}
  `;
  const row = rows[0];
  return row ? {
    decision: row.decision,
    hasSnapshot: row.has_snapshot,
    notificationStatus: row.notification_status,
    requestStartedAt: row.request_started_at,
    firstByteAt: row.first_byte_at,
    bodyReceivedAt: row.body_received_at,
    parsedAt: row.parsed_at,
    hotCandidateAt: row.hot_candidate_at,
    journalPersistedAt: row.journal_persisted_at,
    telegramAcceptedAt: row.telegram_accepted_at,
    notificationAcceptedAt: row.notification_accepted_at,
  } : null;
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    "completeness_audits", "telegram_notifications", "listing_matches", "source_seen_listings",
    "listings", "filters", "source_search_states", "challenge_incidents", "sources",
    "collector_runs", "errors" RESTART IDENTITY CASCADE`);
}

async function seedCatchAllFilter(): Promise<void> {
  await prisma.filter.create({ data: { name: "Integration catch-all", enabled: true, sources: ["OLX"], freshnessMode: "ALL_TIME" } });
}

function stopPostgres(): void {
  spawnSync(pgCtl, ["stop", "-D", pgData, "-m", "fast", "-w"], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 10_000,
  });
  const status = spawnSync(pgCtl, ["status", "-D", pgData], { windowsHide: true, timeout: 2_000 });
  if (status.status === 0) throw new Error("stop PostgreSQL failed: server is still running");
}

function startPostgres(): void {
  if (spawnSync(pgCtl, ["status", "-D", pgData], { windowsHide: true }).status === 0) return;
  spawnSync(pgCtl, ["start", "-D", pgData, "-l", pgLog, "-w"], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 10_000,
  });
  const status = spawnSync(pgCtl, ["status", "-D", pgData], { windowsHide: true, timeout: 2_000 });
  if (status.status !== 0) throw new Error("start PostgreSQL failed: server is not running");
}

function stopRedis(): void {
  spawnSync(redisCli, ["-h", "127.0.0.1", "-p", String(redisPort), "shutdown", "nosave"], {
    windowsHide: true,
    timeout: 2_000,
  });
}

function startRedis(): void {
  if (spawnSync(redisCli, ["-h", "127.0.0.1", "-p", String(redisPort), "ping"], { windowsHide: true }).status === 0) return;
  const child = spawn(redisServer, [redisConfig], { windowsHide: true, detached: true, stdio: "ignore" });
  child.unref();
}

async function waitForRedis(): Promise<void> {
  await retryUntil(async () => redisAvailable(), "Redis restart");
}

async function databaseAvailable(): Promise<boolean> {
  try { await prisma.$queryRaw`SELECT 1`; return true; } catch { return false; }
}

async function redisAvailable(): Promise<boolean> {
  return spawnSync(redisCli, ["-h", "127.0.0.1", "-p", String(redisPort), "ping"], {
    windowsHide: true,
    timeout: 1_000,
  }).status === 0;
}

async function retryUntil(operation: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { if (await operation()) return; } catch (error) { lastError = error; }
    await delay(200);
  }
  throw new Error(`${label} did not become ready: ${errorMessage(lastError)}`);
}

async function expectFailure(operation: () => Promise<unknown>, label: string): Promise<void> {
  const outcome = await within(
    operation().then(() => "SUCCEEDED" as const, () => "FAILED" as const),
    7_000,
    "TIMED_OUT" as const,
  );
  if (outcome === "SUCCEEDED") throw new Error(`${label} unexpectedly succeeded`);
  progress(`${label}: ${outcome}`);
}

async function runChild(mode: string, expectedSuccess: boolean): Promise<void> {
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1] ?? "", mode], {
    env: { ...process.env, AMB_TEST_FAKE_ROOT: fakeRoot },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
  const exit = await waitForChildExit(child, expectedSuccess ? 30_000 : 7_000);
  if (exit.timedOut) child.kill();
  if (!expectedSuccess && !exit.timedOut && exit.code === 0) {
    throw new Error(`${mode} unexpectedly succeeded while PostgreSQL was unavailable`);
  }
  if (expectedSuccess && (exit.timedOut || exit.code !== 0)) {
    throw new Error(`${mode} failed: ${Buffer.concat(output).toString("utf8").trim()}`);
  }
  progress(`${mode}: ${exit.timedOut ? "TIMED_OUT_AND_TERMINATED" : `FAILED_${exit.code}`} ${Buffer.concat(output).toString("utf8").trim()}`);
}

async function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<{ code: number; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { code: child.exitCode, timedOut: false };
    if (child.signalCode !== null) return { code: -1, timedOut: false };
    await delay(50);
  }
  return { code: -1, timedOut: true };
}

function probeListing(externalId: string): NormalizedListing {
  return {
    source: "OLX",
    externalId,
    url: `http://127.0.0.1/olx/d/${externalId}`,
    canonicalUrl: `http://127.0.0.1/olx/d/${externalId}`,
    title: `Volkswagen Golf integration ${externalId}`,
    brand: "Volkswagen",
    model: "Golf",
    year: 2020,
    priceOriginal: 10_000,
    currencyOriginal: "USD",
    priceNormalized: 10_000,
    mileage: 100_000,
    photoUrls: [],
    publishedAt: new Date(),
    timestampConfidence: "HIGH",
    firstSeenAt: new Date(),
    observationChannel: "OLX_PUBLIC_API",
    observationTarget: `integration:${externalId}`,
    raw: { integrationProbe: true },
  };
}

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function within<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return Promise.race([promise, delay(timeoutMs).then(() => fallback)]);
}

function progress(message: string): void {
  const line = `[pipeline-acceptance] ${message}`;
  console.log(line);
  const progressLog = process.env.AMB_TEST_PROGRESS_LOG;
  if (progressLog) appendFileSync(progressLog, `${new Date().toISOString()} ${line}\n`, "utf8");
}
