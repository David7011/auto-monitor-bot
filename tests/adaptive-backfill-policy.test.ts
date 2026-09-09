import { describe, expect, it } from "vitest";
import {
  BACKFILL_EVIDENCE_TRIGGERS,
  backfillDue,
  backfillProfileFromMetrics,
  decideAdaptiveBackfill,
  targetedSources,
  type AdaptiveBackfillEvidence,
  type BackfillRunEvidence,
} from "../apps/api/src/modules/monitoring/backfill-policy.js";

const now = new Date("2026-07-22T12:00:00.000Z");

describe("adaptive backfill policy", () => {
  it("accepts only true depth and recovery triggers as adaptive evidence", () => {
    expect(BACKFILL_EVIDENCE_TRIGGERS).toEqual(["BACKFILL", "RECOVERY"]);
    expect(BACKFILL_EVIDENCE_TRIGGERS).not.toContain("COVERAGE");
  });
  it("does not target any source when there are no active filters", () => {
    expect([...targetedSources([], ["OLX", "AUTO_RIA"])]).toEqual([]);
  });

  it("targets explicit sources and treats an empty source selection as all", () => {
    expect([...targetedSources([{ sources: ["OLX"] }], ["OLX", "AUTO_RIA"])]).toEqual(["OLX"]);
    expect([...targetedSources([{ sources: [] }], ["OLX", "AUTO_RIA"])]).toEqual(["OLX", "AUTO_RIA"]);
  });

  it("collects routine evidence with a light profile instead of repeatedly hammering deep offsets", () => {
    const decision = decideAdaptiveBackfill(evidence(cleanRuns(4)), 120, now);
    expect(decision).toMatchObject({ mode: "EVIDENCE", profile: "LIGHT", intervalSeconds: 120 });
  });

  it("skips duplicate deep recovery for the same unresolved capability generation", () => {
    const decision = decideAdaptiveBackfill({
      ...evidence(cleanRuns(4)),
      unresolvedRecovery: {
        count: 1,
        attemptedGeneration: "olx-public-depth-v1:page=50:offset=1000",
        currentGeneration: "olx-public-depth-v1:page=50:offset=1000",
      },
    }, 120, now);
    expect(decision).toMatchObject({ mode: "UNRESOLVED", profile: "LIGHT", intervalSeconds: 600 });
  });

  it("allows one new recovery when the capability generation changes", () => {
    const decision = decideAdaptiveBackfill({
      ...evidence(cleanRuns(4)),
      unresolvedRecovery: {
        count: 1,
        attemptedGeneration: "olx-public-depth-v1:page=50:offset=1000",
        currentGeneration: "olx-public-depth-v2:page=50:offset=2000",
      },
    }, 120, now);
    expect(decision).toMatchObject({ mode: "RECOVERY", profile: "FULL", intervalSeconds: 120 });
  });

  it("keeps a durable pending window ahead of routine adaptive evidence", () => {
    expect(decideAdaptiveBackfill({
      ...evidence(cleanRuns(8)),
      pendingRecoveryCount: 1,
    }, 120, now)).toMatchObject({ mode: "RECOVERY", profile: "FULL" });
  });

  it("enters lean mode only after a consecutive clean zero-recovery history", () => {
    const runs = cleanRuns(8).map((run, index) => ({ ...run, profile: index === 7 ? "FULL" as const : "LIGHT" as const }));
    const decision = decideAdaptiveBackfill(evidence(runs), 120, now);
    expect(decision).toMatchObject({ mode: "LEAN", profile: "LIGHT", intervalSeconds: 600 });
  });

  it("restores full base-cadence checks on recovery, failure, anomaly, or unresolved journal work", () => {
    const recovered = cleanRuns(8);
    recovered[0] = { ...recovered[0], recoveredCount: 1 };
    expect(decideAdaptiveBackfill(evidence(recovered), 120, now)).toMatchObject({ mode: "RECOVERY", profile: "FULL", intervalSeconds: 120 });

    const failed = cleanRuns(8);
    failed[0] = { ...failed[0], status: "FAILED", errorMessage: "timeout" };
    expect(decideAdaptiveBackfill(evidence(failed), 120, now)).toMatchObject({ mode: "RECOVERY", profile: "FULL" });

    expect(decideAdaptiveBackfill({ ...evidence(cleanRuns(8)), realtimeAnomalyAt: now }, 120, now)).toMatchObject({ mode: "RECOVERY", profile: "FULL" });
    expect(decideAdaptiveBackfill({ ...evidence(cleanRuns(8)), unresolvedObservationCount: 2 }, 120, now)).toMatchObject({ mode: "RECOVERY", profile: "FULL" });
  });

  it("backs off expensive audits after an OLX protection event", () => {
    const runs = cleanRuns(8);
    runs[0] = { ...runs[0], status: "RATE_LIMITED", errorMessage: "HTTP 429" };
    expect(decideAdaptiveBackfill(evidence(runs), 120, now)).toMatchObject({
      mode: "PROTECTION",
      profile: "LIGHT",
      intervalSeconds: 1800,
    });
  });

  it("uses light recovery probes after protection and requires two clean probes before lean mode", () => {
    const protectedAt = new Date(now.getTime() - 31 * 60 * 1000);
    const protectedRun: BackfillRunEvidence = {
      startedAt: protectedAt,
      status: "RATE_LIMITED",
      recoveredCount: 0,
      errorMessage: "HTTP 429",
      profile: "FULL",
    };
    expect(decideAdaptiveBackfill(evidence([protectedRun]), 120, now)).toMatchObject({
      mode: "PROTECTION",
      profile: "LIGHT",
      intervalSeconds: 600,
    });

    const oneClean = { ...cleanRuns(1)[0]!, startedAt: new Date(protectedAt.getTime() + 10 * 60 * 1000), profile: "LIGHT" as const };
    expect(decideAdaptiveBackfill(evidence([oneClean, protectedRun]), 120, now)).toMatchObject({
      mode: "PROTECTION",
      profile: "LIGHT",
    });

    const secondClean = { ...oneClean, startedAt: new Date(protectedAt.getTime() + 20 * 60 * 1000) };
    expect(decideAdaptiveBackfill(evidence([secondClean, oneClean, protectedRun]), 120, now)).toMatchObject({
      mode: "LEAN",
      profile: "LIGHT",
      intervalSeconds: 600,
    });
  });

  it("honors the protection cooldown even when a newer probe recovered an advert and a gap remains pending", () => {
    const runs: BackfillRunEvidence[] = [
      { ...cleanRuns(1)[0]!, recoveredCount: 1, profile: "LIGHT" },
      { ...cleanRuns(1)[0]!, startedAt: new Date(now.getTime() - 5 * 60_000),
        status: "RATE_LIMITED", errorMessage: "HTTP 429" },
    ];
    const decision = decideAdaptiveBackfill({ ...evidence(runs), pendingRecoveryCount: 1 }, 120, now);
    expect(decision).toMatchObject({ mode: "PROTECTION", profile: "LIGHT", intervalSeconds: 1800 });
    expect(backfillDue(runs[0]!.startedAt, decision, now)).toBe(false);
    expect(decideAdaptiveBackfill({ ...evidence(runs), pendingRecoveryCount: 1 }, 120,
      new Date(now.getTime() + 31 * 60_000))).toMatchObject({ mode: "RECOVERY", profile: "FULL" });
  });

  it("stops treating old recovery evidence as active after two newer clean backfills", () => {
    const runsAfterAudit = cleanRuns(8);
    const auditAt = new Date(now.getTime() - 5 * 60 * 1000);
    expect(decideAdaptiveBackfill({ ...evidence(runsAfterAudit), adverseAuditAt: auditAt }, 120, now))
      .toMatchObject({ mode: "LEAN", profile: "LIGHT", intervalSeconds: 600 });

    const runsAfterRecovered = cleanRuns(8);
    runsAfterRecovered[2] = { ...runsAfterRecovered[2], recoveredCount: 2 };
    expect(decideAdaptiveBackfill(evidence(runsAfterRecovered), 120, now))
      .toMatchObject({ mode: "EVIDENCE", profile: "LIGHT", intervalSeconds: 120 });
  });

  it("forces a periodic full-depth audit even during a clean lean period", () => {
    const recentLight = cleanRuns(8).map((run) => ({ ...run, profile: "LIGHT" as const }));
    const oldFull: BackfillRunEvidence = {
      ...recentLight.at(-1)!,
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      profile: "FULL",
    };
    const decision = decideAdaptiveBackfill(evidence([...recentLight, oldFull]), 120, now);
    expect(decision).toMatchObject({ mode: "PERIODIC_FULL", profile: "FULL", intervalSeconds: 600 });
  });

  it("rejects stale evidence and calculates due time from the selected cadence", () => {
    const stale = cleanRuns(8, new Date(now.getTime() - 16 * 60 * 1000));
    expect(decideAdaptiveBackfill(evidence(stale), 120, now)).toMatchObject({ mode: "RECOVERY", profile: "FULL" });
    expect(backfillDue(new Date(now.getTime() - 599_000), { intervalSeconds: 600 }, now)).toBe(false);
    expect(backfillDue(new Date(now.getTime() - 600_000), { intervalSeconds: 600 }, now)).toBe(true);
  });

  it("reads the persisted profile and treats legacy runs as full-depth", () => {
    expect(backfillProfileFromMetrics([{ kind: "backfill-policy", profile: "LIGHT" }])).toBe("LIGHT");
    expect(backfillProfileFromMetrics([{ unrelated: true }])).toBe("FULL");
  });
});

function evidence(runs: BackfillRunEvidence[]): AdaptiveBackfillEvidence {
  return { runs, unresolvedObservationCount: 0 };
}

function cleanRuns(count: number, latestAt = now): BackfillRunEvidence[] {
  return Array.from({ length: count }, (_, index) => ({
    startedAt: new Date(latestAt.getTime() - index * 120_000),
    status: "SUCCESS",
    recoveredCount: 0,
    errorMessage: null,
    profile: "FULL",
  }));
}
