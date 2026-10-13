import assert from "node:assert/strict";
import { createServer } from "node:http";
import { realpathSync, appendFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { Worker } from "bullmq";
import { prisma, closeDatabase } from "@amb/db";
import { QUEUE_NAMES } from "@amb/shared";
import { queueTelegramFirstSignals } from "../../apps/worker/src/modules/telegram-first-signal.js";
import { configureTelegramApiRootForIntegrationTest } from "../../apps/worker/src/modules/telegram-service.js";
import { processTelegramFlash, processTelegramSend } from "../../apps/worker/src/processors/telegram.js";
import { bullConnection, closeQueues, redisConnection } from "../../apps/worker/src/lib/queues.js";

const db = new URL(process.env.DATABASE_URL ?? "http://invalid");
const redis = new URL(process.env.REDIS_URL ?? "http://invalid");
const pgData = realpathSync(process.env.AMB_TEST_PG_DATA ?? ".");
const root = realpathSync(resolve("../../.runtime/pipeline-acceptance")) + sep;
assert(process.env.AMB_PIPELINE_INTEGRATION_TEST === "1" && process.env.TELEGRAM_BOT_TOKEN === "test-token"
  && db.username === "amb_test" && db.pathname === "/amb_pipeline_test" && db.hostname === "127.0.0.1"
  && redis.hostname === "127.0.0.1" && redis.port !== "6380" && db.port !== "55432"
  && pgData.toLowerCase().startsWith(root.toLowerCase()), "Refusing non-isolated Telegram fixture");
const events: Array<{ chat: string; phase: string; at: number }> = [];
let holdOwner = false;
let blockOwner = false;
let sequence = 0;
const fake = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const chat = String(body.chat_id);
  const phase = String(body.text ?? "").includes("FLASH:") ? "signal" : "detail";
  if (chat === "1" && blockOwner) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }));
    return;
  }
  if (chat === "1" && holdOwner && phase === "signal") await new Promise(r => setTimeout(r, 6_000));
  events.push({ chat, phase, at: Date.now() });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, result: { message_id: ++sequence, date: Math.floor(Date.now() / 1000), chat: { id: Number(chat), type: "private" } } }));
});
const workers: Worker[] = [];
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
async function listing(externalId: string) {
  return prisma.listing.create({ data: { source: "OLX", externalId, title: externalId, url: `https://example.test/${externalId}`, canonicalUrl: `https://example.test/${externalId}`, status: "MATCHED", firstSeenAt: new Date() } });
}
async function main() {
try {
  await redisConnection.connect();
  await new Promise<void>(resolveListen => fake.listen(0, "127.0.0.1", resolveListen));
  const address = fake.address();
  assert(address && typeof address !== "string");
  configureTelegramApiRootForIntegrationTest(`http://127.0.0.1:${address.port}`);
  await prisma.telegramSubscriber.create({ data: { chatId: "2", active: true } });
  const first = await listing("slow-owner");
  // Concurrent overlapping admissions must retain exactly one signal per recipient.
  await Promise.all([queueTelegramFirstSignals([first.id], "batch-a"), queueTelegramFirstSignals([first.id], "batch-b")]);
  assert.equal(await prisma.telegramFlashBundle.count(), 2);
  assert.equal(await prisma.telegramNotification.count(), 2);
  holdOwner = true;
  workers.push(new Worker(QUEUE_NAMES.TELEGRAM_FLASH, job => processTelegramFlash(job.data), { connection: bullConnection, concurrency: 2 }));
  workers.push(new Worker(QUEUE_NAMES.TELEGRAM_SEND, job => processTelegramSend(job.data), { connection: bullConnection, concurrency: 2 }));
  for (const worker of workers) worker.on("error", () => {});
  await until(async () => events.some(e => e.chat === "2" && e.phase === "signal"), "subscriber first signal");
  assert(!events.some(e => e.chat === "1" && e.phase === "signal"), "Slow owner blocked subscriber");
  await until(async () => await prisma.telegramNotification.count({ where: { listingId: first.id, status: "DELIVERED" } }) === 2, "both detail receipts");
  const signal = events.filter(e => e.phase === "signal");
  assert.equal(signal.length, 2);
  assert(signal.find(e => e.chat === "1")!.at - signal.find(e => e.chat === "2")!.at > 5_000);
  await queueTelegramFirstSignals([first.id], "retry");
  assert.equal(await prisma.telegramFlashBundle.count(), 2, "Retry duplicated first signal");
  holdOwner = false;
  blockOwner = true;
  const second = await listing("blocked-owner");
  await queueTelegramFirstSignals([second.id], "blocked");
  await until(async () => await prisma.telegramNotification.count({ where: { listingId: second.id, chatId: "2", status: "DELIVERED" } }) === 1, "subscriber survives blocked owner");
  await until(async () => await prisma.telegramFlashBundle.count({ where: { chatId: "1", status: "PERMANENT" } }) === 1, "owner permanent outcome");
  const summary = { passed: true, checks: ["concurrent durable fan-out", "slow owner does not block subscriber (>5s)", "per-recipient details", "idempotent admission", "permanent owner failure isolated"], events };
  appendFileSync(resolve(pgData, "../progress.log"), JSON.stringify(summary) + "\n");
  console.log(JSON.stringify(summary));
} finally {
  for (const worker of workers) await worker.close();
  await closeQueues();
  await closeDatabase();
  await new Promise<void>(done => fake.close(() => done()));
}
process.exit(0);
}
void main().catch(error => { console.error(error); process.exit(1); });
