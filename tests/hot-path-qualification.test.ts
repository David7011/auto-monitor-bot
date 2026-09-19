import { describe, expect, it } from "vitest";
import {
  qualificationEvidence,
  selectQualificationSamples,
} from "../apps/worker/src/maintenance/hot-path-qualification.js";

describe("OLX hot-path qualification sample selection", () => {
  const sample = (firstSeenAt: string) => ({ firstSeenAt: new Date(firstSeenAt) });

  it("never mixes observations from before the current qualification baseline", () => {
    const selected = selectQualificationSamples([
      sample("2026-09-15T18:29:14.316Z"),
      sample("2026-09-15T18:29:14.317Z"),
      sample("2026-09-16T00:00:00.000Z"),
    ], new Date("2026-09-15T18:29:14.317Z"));

    expect(selected.map((entry) => entry.firstSeenAt.toISOString())).toEqual([
      "2026-09-15T18:29:14.317Z",
      "2026-09-16T00:00:00.000Z",
    ]);
  });

  it("keeps p99 unavailable until 100 complete accepted traces", () => {
    expect(qualificationEvidence(58)).toEqual({
      completeAcceptedSamples: 58,
      p99SamplesRequired: 100,
      p99SamplesRemaining: 42,
      p99Ready: false,
    });
    expect(qualificationEvidence(100)).toMatchObject({
      p99SamplesRemaining: 0,
      p99Ready: true,
    });
  });

  it("returns no baseline samples when qualification state is unavailable", () => {
    expect(selectQualificationSamples([sample("2026-09-16T00:00:00.000Z")], null)).toEqual([]);
  });
});
