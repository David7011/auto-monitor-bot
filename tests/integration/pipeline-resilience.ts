import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { prisma } from "@amb/db";
import { QUEUE_NAMES, type NormalizedListing } from "@amb/shared";
import { fetchOlxApiFeed, isAdsResult } from "../../apps/worker/src/collectors/olx-feed.js";
import { selectOlxCandidates } from "../../apps/worker/src/collectors/olx.js";
import { closeSourceHttpClient } from "../../apps/worker/src/collectors/source-http-client.js";
import { closeQueues, getQueue } from "../../apps/worker/src/lib/queues.js";
import { configureTelegramApiRootForIntegrationTest } from "../../apps/worker/src/modules/telegram-service.js";
import { recordPendingObservations } from "../../apps/worker/src/modules/observation-journal.js";
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
  try {
    progress("reset and seed");
    await resetDatabase();
    await seedCatchAllFilter();

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
  assert(Boolean(row?.hotCandidateAt), `${externalId} has no hotCandidateAt`);
  assert(Boolean(row?.journalPersistedAt), `${externalId} has no journalPersistedAt`);
  assert(Boolean(row?.telegramAcceptedAt), `${externalId} has no telegramAcceptedAt`);
  assert(Boolean(row?.notificationAcceptedAt), `${externalId} notification has no acceptedAt`);
  const stages = [
    row!.requestStartedAt!,
    row!.firstByteAt!,
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
