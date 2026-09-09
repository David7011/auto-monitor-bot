import { describe, expect, it } from "vitest";
import {
  decideOlxCadenceCanary,
  type OlxCadenceCanaryConfig,
  type OlxCadenceCanaryState,
  type OlxCadenceRunEvidence,
} from "../apps/api/src/modules/monitoring/olx-cadence-canary-policy.js";

const epoch = new Date("2026-08-30T10:00:00.000Z");
const config: OlxCadenceCanaryConfig = {
  enabled: true,
  qualificationRuns: 100,
  promotionRuns: 100,
  hotPathMinimumSamples: 30,
  p95MinimumSamples: 30,
  qualificationMaximumP95Ms: 8_000,
  maximumP95Ms: 12_000,
  p95GrowthRatio: 1.25,
  baseIntervalSeconds: 20,
  baseJitterSeconds: 4,
  canaryIntervalSeconds: 18,
  canaryJitterSeconds: 3,
};

function state(overrides: Partial<OlxCadenceCanaryState> = {}): OlxCadenceCanaryState {
  return {
    mode: "BASELINE",
    qualificationStartedAt: epoch,
    canaryStartedAt: null,
    baselineP95Ms: null,
    rollbackReason: null,
    ...overrides,
  };
}

function cleanRuns(count: number, durationMs = 4_000, startAt = epoch): OlxCadenceRunEvidence[] {
  return Array.from({ length: count }, (_, index) => {
    const startedAt = new Date(startAt.getTime() + (count - index) * 20_000);
    return {
      id: `run-${count - index}`,
      status: "SUCCESS",
      startedAt,
      finishedAt: new Date(startedAt.getTime() + durationMs),
      recoveredCount: 0,
      semanticWarnings: [],
      errorMessage: null,
    };
  });
}

function decide(input: {
  current?: OlxCadenceCanaryState;
  runs?: OlxCadenceRunEvidence[];
  protectionActive?: boolean;
  queueOverflow?: boolean;
  now?: Date;
  configuration?: OlxCadenceCanaryConfig;
}) {
  return decideOlxCadenceCanary({
    state: input.current ?? state(),
    config: input.configuration ?? config,
    runs: input.runs ?? [],
    hotPathSampleCount: 30,
    protectionActive: input.protectionActive ?? false,
    queueOverflow: input.queueOverflow ?? false,
    now: input.now ?? new Date("2026-08-30T11:00:00.000Z"),
  });
}

describe("OLX cadence canary policy", () => {
  it("waits for one hundred consecutive clean realtime runs", () => {
    const waiting = decide({ runs: cleanRuns(99) });
    expect(waiting).toMatchObject({ mode: "BASELINE", cleanRunCount: 99, intervalSeconds: 20, jitterSeconds: 4 });

    const entered = decide({ runs: cleanRuns(100) });
    expect(entered).toMatchObject({
      mode: "CANARY",
      transition: "ENTER_CANARY",
      cleanRunCount: 100,
      baselineP95Ms: 4_000,
      intervalSeconds: 18,
      jitterSeconds: 3,
    });
  });

  it("does not accelerate before a complete accepted hot-path sample exists", () => {
    const waiting = decideOlxCadenceCanary({
      state: state(),
      config,
      runs: cleanRuns(100),
      hotPathSampleCount: 29,
      protectionActive: false,
      queueOverflow: false,
    });
    expect(waiting).toMatchObject({ mode: "BASELINE", intervalSeconds: 20, jitterSeconds: 4 });
    expect(waiting.reason).toBe("complete OLX hot-path samples 29/30");
  });

  it("rolls an already accelerated cadence back when complete live evidence is insufficient", () => {
    const current = state({ mode: "PROMOTED", canaryStartedAt: epoch, baselineP95Ms: 4_000 });
    const decision = decideOlxCadenceCanary({
      state: current,
      config,
      runs: cleanRuns(100),
      hotPathSampleCount: 3,
      protectionActive: false,
      queueOverflow: false,
      now: new Date("2026-08-30T12:00:00.000Z"),
    });
    expect(decision).toMatchObject({
      mode: "ROLLED_BACK",
      transition: "ROLLBACK",
      intervalSeconds: 20,
      jitterSeconds: 4,
      rollbackReason: "complete OLX hot-path samples 3/30",
    });
  });

  it("counts only the clean suffix and rejects a slow qualification p95", () => {
    const dirty = { ...cleanRuns(1)[0]!, status: "LIMITED" };
    expect(decide({ runs: [...cleanRuns(20), dirty, ...cleanRuns(100)] }).cleanRunCount).toBe(20);
    expect(decide({ runs: cleanRuns(100, 8_001) })).toMatchObject({ mode: "BASELINE", currentP95Ms: 8_001 });
  });

  it.each([
    ["protection", { protectionActive: true }, "OLX protection signal"],
    ["queue pressure", { queueOverflow: true }, "hot-path queue overflow"],
  ])("rolls back immediately on %s", (_label, signal, reason) => {
    const decision = decide({
      current: state({ mode: "CANARY", canaryStartedAt: epoch, baselineP95Ms: 4_000 }),
      runs: cleanRuns(2),
      ...signal,
    });
    expect(decision).toMatchObject({ mode: "ROLLED_BACK", transition: "ROLLBACK", intervalSeconds: 20, jitterSeconds: 4 });
    expect(decision.rollbackReason).toContain(reason);
  });

  it("rolls back on an OLX window overflow or a single run beyond the hard limit", () => {
    const overflowRun = { ...cleanRuns(1)[0]!, semanticWarnings: ["OLX realtime window overflow"] };
    const current = state({ mode: "CANARY", canaryStartedAt: epoch, baselineP95Ms: 4_000 });
    expect(decide({ current, runs: [overflowRun] }).rollbackReason).toMatch(/overflow/iu);
    expect(decide({ current, runs: cleanRuns(1, 12_001) }).rollbackReason).toContain("hard limit");
  });

  it("uses a minimum sample before rolling back on p95 growth", () => {
    const current = state({ mode: "CANARY", canaryStartedAt: epoch, baselineP95Ms: 4_000 });
    expect(decide({ current, runs: cleanRuns(29, 6_000) })).toMatchObject({ mode: "CANARY", transition: "NONE" });
    expect(decide({ current, runs: cleanRuns(30, 6_000) })).toMatchObject({ mode: "ROLLED_BACK", transition: "ROLLBACK", currentP95Ms: 6_000 });
  });

  it("promotes after one hundred clean canary runs but keeps the rollback guard", () => {
    const current = state({ mode: "CANARY", canaryStartedAt: epoch, baselineP95Ms: 4_000 });
    expect(decide({ current, runs: cleanRuns(100) })).toMatchObject({
      mode: "PROMOTED",
      transition: "PROMOTE",
      intervalSeconds: 18,
      jitterSeconds: 3,
    });
    const promoted = state({ mode: "PROMOTED", canaryStartedAt: epoch, baselineP95Ms: 4_000 });
    expect(decide({ current: promoted, runs: cleanRuns(1), protectionActive: true })).toMatchObject({ mode: "ROLLED_BACK", transition: "ROLLBACK" });
  });

  it("fails closed when canary is disabled", () => {
    expect(decide({ configuration: { ...config, enabled: false }, runs: cleanRuns(100) })).toMatchObject({
      mode: "DISABLED",
      intervalSeconds: 20,
      jitterSeconds: 4,
    });
  });
});
