import { closeDatabase, prisma } from "@amb/db";
import { env } from "../env.js";

const LEGACY_API_DENIAL = "AUTO.RIA вернул ограничение доступа HTTP 403";
const PUBLIC_LIMITATION = "AUTO.RIA public:";

async function main(): Promise<void> {
  if (env.AUTO_RIA_ACCESS_MODE !== "public") {
    throw new Error("AUTO.RIA public re-arm is allowed only in public access mode");
  }
  const current = await prisma.source.findUnique({
    where: { source: "AUTO_RIA" },
    select: { id: true, enabled: true, status: true, pausedUntil: true, lastError: true, intervalSeconds: true, jitterSeconds: true },
  });
  if (!current?.enabled) throw new Error("AUTO.RIA source is not enabled");
  const legacyApiPause = current.status === "RATE_LIMITED"
    && Boolean(current.pausedUntil && current.pausedUntil > new Date())
    && Boolean(current.lastError?.startsWith(LEGACY_API_DENIAL));
  if (!legacyApiPause) {
    if (current.status === "LIMITED" && !current.pausedUntil && current.lastError?.startsWith(PUBLIC_LIMITATION)) {
      await prisma.source.updateMany({
        where: { id: current.id, status: "LIMITED", pausedUntil: null },
        data: {
          nextCheckAt: new Date(),
          intervalSeconds: env.LIVE_AUTO_RIA_MIN_INTERVAL_SECONDS,
          jitterSeconds: env.LIVE_AUTO_RIA_JITTER_SECONDS,
        },
      });
      console.log("AUTO.RIA public source scheduled for an immediate healthy-path check");
      return;
    }
    console.log("AUTO.RIA public source did not require legacy API pause reconciliation");
    return;
  }
  const changed = await prisma.source.updateMany({
    where: {
      id: current.id,
      status: "RATE_LIMITED",
      pausedUntil: current.pausedUntil,
      lastError: { startsWith: LEGACY_API_DENIAL },
    },
    data: {
      status: "ACTIVE",
      pausedUntil: null,
      nextCheckAt: new Date(),
      intervalSeconds: env.LIVE_AUTO_RIA_MIN_INTERVAL_SECONDS,
      jitterSeconds: env.LIVE_AUTO_RIA_JITTER_SECONDS,
      consecutiveErrors: 0,
      lastError: null,
    },
  });
  console.log(changed.count === 1
    ? "AUTO.RIA public source re-armed after retiring the legacy API path"
    : "AUTO.RIA source changed concurrently; no state was overwritten");
}

main()
  .finally(() => closeDatabase())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
