import { describe, expect, it } from "vitest";
import {
  classifyObservationContract,
  summarizeCompletenessFacts,
  summarizeCompletenessGroups,
} from "../apps/worker/src/modules/completeness-contract.js";

describe("zero silent internal loss contract", () => {
  it.each([
    [{ decision: "NOTIFIED", hasNormalizedSnapshot: true, hasListing: true, notificationStatus: "SENT", notificationAccepted: true }, "NOTIFIED"],
    [{ decision: "REJECTED", hasNormalizedSnapshot: true, hasListing: false, notificationStatus: null, notificationAccepted: false }, "REJECTED"],
    [{ decision: "DUPLICATE", hasNormalizedSnapshot: true, hasListing: false, notificationStatus: null, notificationAccepted: false }, "DUPLICATE"],
    [{ decision: "MATCHED", hasNormalizedSnapshot: true, hasListing: true, listingMode: "SHADOW", notificationStatus: null, notificationAccepted: false }, "SHADOWED"],
    [{ decision: "PENDING", hasNormalizedSnapshot: true, hasListing: false, notificationStatus: null, notificationAccepted: false }, "RECOVERY_PENDING"],
    [{ decision: "FAILED", hasNormalizedSnapshot: true, hasListing: false, notificationStatus: null, notificationAccepted: false }, "FAILED_REPLAYABLE"],
  ] as const)("classifies %j as %s", (input, expected) => {
    expect(classifyObservationContract(input)).toBe(expected);
  });

  it("rejects a claimed terminal state without its durable receipt", () => {
    expect(classifyObservationContract({
      decision: "NOTIFIED",
      hasNormalizedSnapshot: true,
      hasListing: true,
      notificationStatus: "PROCESSING",
      notificationAccepted: false,
    })).toBe("IMPOSSIBLE");
  });

  it("accepts a compact retained notification receipt after heavy rows are removed", () => {
    expect(classifyObservationContract({
      decision: "NOTIFIED",
      hasNormalizedSnapshot: true,
      hasListing: false,
      notificationStatus: null,
      notificationAccepted: false,
      observationAccepted: true,
    })).toBe("NOTIFIED");
  });

  it("rejects a nonterminal observation that has neither a snapshot nor a listing", () => {
    expect(classifyObservationContract({
      decision: "PENDING",
      hasNormalizedSnapshot: false,
      hasListing: false,
      notificationStatus: null,
      notificationAccepted: false,
    })).toBe("IMPOSSIBLE");
  });

  it("separates impossible corruption from durable replay backlog", () => {
    const summary = summarizeCompletenessFacts([
      { code: "LISTING_WITHOUT_OBSERVATION", identity: "OLX:1" },
      { code: "STALE_REPLAYABLE_OBSERVATION", identity: "OLX:2" },
      { code: "BOUNDARY_AHEAD_OF_INCOMPLETE_OBSERVATION", identity: "OLX:3" },
    ]);
    expect(summary).toMatchObject({ impossibleCount: 1, recoverableCount: 2, ok: false });
  });

  it("separates exact totals from a truncated sample and continuity-only evidence", () => {
    const summary = summarizeCompletenessGroups([
      {
        code: "KNOWN_ID_WITHOUT_OBSERVATION",
        totalCount: 120,
        oldestRecoverableAt: "2026-09-01T00:00:00.000Z",
        sample: [{ identity: "OLX:anchor" }],
      },
      {
        code: "STALE_REPLAYABLE_OBSERVATION",
        totalCount: 3,
        oldestRecoverableAt: "2026-09-02T00:00:00.000Z",
        sample: [{ identity: "OLX:pending" }],
      },
    ]);
    expect(summary).toMatchObject({
      totalCount: 123,
      sampleCount: 2,
      truncated: true,
      impossibleCount: 0,
      recoverableCount: 123,
      replayable: 3,
      continuityOnly: 120,
      oldestRecoverableAt: "2026-09-02T00:00:00.000Z",
      ok: true,
      fullyRecoverable: false,
      clean: false,
    });
    expect(summary.findings).toEqual([
      expect.objectContaining({ identity: "OLX:anchor", recovery: "CONTINUITY_ONLY" }),
      expect.objectContaining({ identity: "OLX:pending", recovery: "REPLAYABLE" }),
    ]);
  });

  it("reports fullyRecoverable only when every non-clean finding is replayable", () => {
    expect(summarizeCompletenessGroups([{
      code: "STALE_REPLAYABLE_OBSERVATION",
      totalCount: 1,
      sample: [{ identity: "OLX:pending" }],
    }])).toMatchObject({ ok: true, fullyRecoverable: true, replayable: 1, continuityOnly: 0 });
    expect(summarizeCompletenessGroups([{
      code: "LISTING_WITHOUT_OBSERVATION",
      totalCount: 1,
      sample: [{ identity: "OLX:broken" }],
    }])).toMatchObject({ ok: false, fullyRecoverable: false, impossibleCount: 1 });
  });
});
