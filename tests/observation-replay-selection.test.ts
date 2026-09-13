import { describe, expect, it } from "vitest";
import { observationReplayWhere } from "../apps/worker/src/modules/observation-replay-selection.js";

describe("durable replay selection", () => {
  it("keeps unfinished work independent of historical lookback and retains retry backoff", () => {
    const now = new Date("2026-09-13T18:00:00Z");
    const query = observationReplayWhere(new Date("2026-09-11T18:00:00Z"), "revision", now);
    const durable = query.OR?.[0];
    expect(durable).toMatchObject({ listingId: null, decision: { in: ["PENDING", "FAILED", "MATCHED", "DISPATCHED"] } });
    expect(durable).not.toHaveProperty("firstSeenAt");
    expect(durable).not.toHaveProperty("publishedAt");
    expect(durable).toMatchObject({ OR: [{ lastEvaluatedAt: null }, { lastEvaluatedAt: { lte: new Date("2026-09-13T17:55:00Z") } }] });
    expect(query).toMatchObject({ notifiedAt: null, telegramAcceptedAt: null, decision: { not: "NOTIFIED" } });
  });
});
