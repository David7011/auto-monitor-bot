import { describe, expect, it } from "vitest";
import {
  olxRecoveryAttemptGeneration,
  olxRecoveryRetryEligible,
} from "../packages/shared/src/utils/olx-recovery.js";

describe("OLX recovery capability generation", () => {
  it("is stable across ordinary runtime events", () => {
    expect(olxRecoveryAttemptGeneration({ pageSize: 50, maxOffset: 1_000 }))
      .toBe("olx-public-depth-v1:page=50:offset=1000");
  });

  it("retries only after a meaningful capability change or an explicit force", () => {
    const currentGeneration = olxRecoveryAttemptGeneration({ pageSize: 50, maxOffset: 1_000 });
    expect(olxRecoveryRetryEligible({ attemptedGeneration: currentGeneration, currentGeneration })).toBe(false);
    expect(olxRecoveryRetryEligible({ attemptedGeneration: "older", currentGeneration })).toBe(true);
    expect(olxRecoveryRetryEligible({ attemptedGeneration: currentGeneration, currentGeneration, forced: true })).toBe(true);
  });
});
