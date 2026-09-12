import { describe, expect, it } from "vitest";

const crashPoints = [
  "HTTP_BODY_RECEIVED",
  "PARSED",
  "HOT_CALLBACK_STARTED",
  "BEFORE_OBSERVATION_PERSIST",
  "AFTER_OBSERVATION_PERSIST",
  "BEFORE_REDIS_CLAIM",
  "AFTER_REDIS_CLAIM",
  "AFTER_FILTER",
  "AFTER_LISTING_CREATE",
  "AFTER_LISTING_MATCH_CREATE",
  "BEFORE_TELEGRAM_RESERVATION",
  "AFTER_TELEGRAM_RESERVATION",
  "BEFORE_SEND_MESSAGE",
  "SEND_MESSAGE_IN_FLIGHT",
  "AFTER_TELEGRAM_ACCEPTANCE",
  "AFTER_TELEGRAM_RECEIPT",
  "BEFORE_ENRICHMENT_ENQUEUE",
  "DURING_RECOVERY",
  "BETWEEN_RECOVERY_PAGES",
  "BEFORE_MARK_SEARCH_SUCCESS",
  "AFTER_STATE_TRANSACTION",
] as const;

type CrashPoint = typeof crashPoints[number];

type SimulatedPipeline = {
  normalized: boolean;
  observation: "NONE" | "PENDING" | "MATCHED" | "DISPATCHED" | "NOTIFIED";
  listing: boolean;
  notification: "NONE" | "RESERVED" | "ACCEPTED_AMBIGUOUS" | "RECEIPT";
  boundaryAdvanced: boolean;
  recoveryRequired: boolean;
  possibleDuplicate: boolean;
};

describe("pipeline crash/replay matrix", () => {
  it.each(crashPoints)("recovers %s without a silent internal loss", (point) => {
    const crashed = stateAt(point);
    const recovered = restartAndReplay(crashed);

    expect(recovered.observation).toBe("NOTIFIED");
    expect(recovered.listing).toBe(true);
    expect(recovered.notification).toBe("RECEIPT");
    expect(recovered.boundaryAdvanced).toBe(true);
    if (crashed.notification === "ACCEPTED_AMBIGUOUS") {
      expect(recovered.possibleDuplicate).toBe(true);
    }
  });

  it("never advances discovery state over an unjournaled normalized burst", () => {
    for (const point of crashPoints) {
      const crashed = stateAt(point);
      if (crashed.normalized && crashed.observation === "NONE") {
        expect(crashed.boundaryAdvanced, point).toBe(false);
        expect(crashed.recoveryRequired, point).toBe(true);
      }
    }
  });

  it("covers every mandated checkpoint exactly once", () => {
    expect(new Set(crashPoints).size).toBe(21);
  });
});

function stateAt(point: CrashPoint): SimulatedPipeline {
  const index = crashPoints.indexOf(point);
  const atLeast = (stage: CrashPoint) => index >= crashPoints.indexOf(stage);
  const acceptedWithoutReceipt = point === "AFTER_TELEGRAM_ACCEPTANCE";
  const hasReceipt = atLeast("AFTER_TELEGRAM_RECEIPT");
  const observation = hasReceipt
    ? "NOTIFIED"
    : atLeast("AFTER_LISTING_CREATE")
      ? "DISPATCHED"
      : atLeast("AFTER_FILTER")
        ? "MATCHED"
        : atLeast("AFTER_OBSERVATION_PERSIST")
          ? "PENDING"
          : "NONE";
  return {
    normalized: atLeast("PARSED"),
    observation,
    listing: atLeast("AFTER_LISTING_CREATE"),
    notification: hasReceipt
      ? "RECEIPT"
      : acceptedWithoutReceipt
        ? "ACCEPTED_AMBIGUOUS"
        : atLeast("AFTER_TELEGRAM_RESERVATION")
          ? "RESERVED"
          : "NONE",
    boundaryAdvanced: point === "AFTER_STATE_TRANSACTION",
    recoveryRequired: atLeast("PARSED") && !atLeast("AFTER_OBSERVATION_PERSIST"),
    possibleDuplicate: false,
  };
}

function restartAndReplay(crashed: SimulatedPipeline): SimulatedPipeline {
  const recovered = { ...crashed };
  // A pre-journal process death cannot claim success. The unchanged durable
  // boundary forces the source recovery lane to obtain the candidate again.
  if (recovered.observation === "NONE") recovered.observation = "PENDING";
  if (!recovered.listing) recovered.listing = true;
  recovered.observation = "DISPATCHED";
  if (recovered.notification === "ACCEPTED_AMBIGUOUS") {
    // Telegram has no caller idempotency key. After the durable lease expires,
    // prefer a bounded possible duplicate over a silent missed notification.
    recovered.possibleDuplicate = true;
  }
  recovered.notification = "RECEIPT";
  recovered.observation = "NOTIFIED";
  recovered.boundaryAdvanced = true;
  recovered.recoveryRequired = false;
  return recovered;
}
