import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceSearchContext, SourceSearchState } from "../apps/worker/src/collectors/base.js";

const mocks = vi.hoisted(() => ({ lock: vi.fn(), findState: vi.fn(), updateState: vi.fn(),
  findWindows: vi.fn(), updateWindow: vi.fn(), updateWindows: vi.fn(), createWindow: vi.fn() }));
vi.mock("../packages/db/src/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../packages/db/src/index.js")>(),
  prisma: { $transaction: async (operation: (tx: unknown) => unknown) => operation({
    $queryRaw: mocks.lock, sourceSearchState: { findUnique: mocks.findState, update: mocks.updateState },
    coverageRecoveryWindow: { findMany: mocks.findWindows, update: mocks.updateWindow, updateMany: mocks.updateWindows, create: mocks.createWindow },
  }) },
}));
import { markSourceSearchSuccess } from "../apps/worker/src/modules/source-search-plan.js";

const cutoff = new Date("2026-10-12T10:00:00Z");
const context: SourceSearchContext = { source: "OLX", categoryKey: "vehicle.car", categorySchemaVersion: 1,
  sourceCategoryId: 108, plannerVersion: 6, categoryCriteria: {}, unknownPolicy: "MAX_COVERAGE", shadowMode: false,
  fingerprint: "scope", filterIds: ["filter"], models: [], bodyTypes: [], fuelTypes: [], gearboxes: [], driveTypes: [],
  colors: [], regions: [], cities: [], keywords: [], excludeKeywords: [], freshnessMode: "ALL_TIME",
  initialWindowBehavior: "SKIP_EXISTING", maxInitialWindowNotifications: 0, publishedAfter: cutoff };

function window(id: string, requiredCutoffAt = cutoff) {
  return { id, status: "PENDING", requiredCutoffAt, detectedAt: cutoff, attemptCount: 2,
    pageCount: 2, requestCount: 3, observedCount: 50, overlapExternalIds: ["page-2"], overlapPage: 2,
    verifiedAt: null, verifiedRunId: null, verificationMethod: null, unresolvedReason: null, unresolvedAt: null,
    oldestObservedAt: null, latestSeenAt: null, attemptGeneration: "v2" };
}
let current: ReturnType<typeof stateRecord>;
function stateRecord() { return { id: "state", source: "OLX", fingerprint: "scope", categoryKey: "vehicle.car",
  knownExternalIds: ["recent"], coverageAnchorExternalIds: ["anchor"], coverageRecoveryPending: true,
  coverageRecoveryCutoffAt: cutoff, lastSuccessfulScanAt: new Date("2026-10-12T12:00:00Z"),
  recoveryProgressPage: 3, recoveryOverlapPage: 2, recoveryOverlapExternalIds: ["page-2"],
  recoveryConsecutiveNoProgress: 4, recoveryNextAttemptAt: new Date(Date.now() + 80_000),
  newestFirstVerifiedAt: null, knownIdsResetAt: null, initialSyncCompletedAt: cutoff }; }
function snapshot(): SourceSearchState { return { id: current.id, fingerprint: current.fingerprint,
  categoryKey: "vehicle.car",
  knownExternalIds: new Set(current.knownExternalIds), coverageAnchorExternalIds: new Set(current.coverageAnchorExternalIds),
  coverageRecoveryPending: true, coverageRecoveryCutoffAt: current.coverageRecoveryCutoffAt,
  recoveryProgressPage: current.recoveryProgressPage }; }

beforeEach(() => {
  vi.clearAllMocks(); current = stateRecord();
  mocks.findState.mockImplementation(async () => current);
  mocks.findWindows.mockResolvedValue([window("oldest")]);
  mocks.updateWindow.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...window("oldest"), ...data }));
  mocks.updateWindows.mockResolvedValue({ count: 1 });
  mocks.updateState.mockResolvedValue({});
});

describe("OLX durable recovery coalescing and progress", () => {
  it("preserves backoff across realtime overflow without opening another pending window", async () => {
    const result = await markSourceSearchSuccess(context, snapshot(), [], { lane: "REALTIME", coverageGap: true });
    expect(result.recoveryNextAttemptAt).toEqual(current.recoveryNextAttemptAt);
    expect(mocks.createWindow).not.toHaveBeenCalled();
    expect(mocks.updateState).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ coverageRecoveryCutoffAt: cutoff }) }));
  });
  it("preserves the newer overlap when a stale page attempt arrives", async () => {
    await markSourceSearchSuccess(context, snapshot(), [], { lane: "BACKFILL", recoveryProgressPage: 2,
      recoveryOverlapPage: 1, recoveryOverlapExternalIds: ["stale"] });
    expect(mocks.updateState).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      recoveryProgressPage: 3, recoveryOverlapPage: 2, recoveryOverlapExternalIds: ["page-2"],
    }) }));
    expect(mocks.updateWindow).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ overlapExternalIds: ["page-2"] }) }));
  });
  it("cannot verify multiple windows using a recent frozen anchor", async () => {
    mocks.findWindows.mockResolvedValue([window("oldest"), window("recent", new Date("2026-10-12T11:00:00Z"))]);
    const result = await markSourceSearchSuccess(context, snapshot(), [], { lane: "BACKFILL", coverageVerified: true,
      coverageVerificationMethod: "KNOWN_TAIL", recoveryProgressPage: 4 });
    expect(result.recoveryVerified).toBe(false);
    expect(result.recoveryRequired).toBe(true);
    expect(mocks.updateWindows).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PENDING" }) }));
  });
  it("verifies every pending window in one pass only after the oldest cutoff is covered", async () => {
    mocks.findWindows.mockResolvedValue([window("oldest"), window("recent", new Date("2026-10-12T11:00:00Z"))]);
    const result = await markSourceSearchSuccess(context, snapshot(), [], { lane: "BACKFILL", coverageVerified: true,
      coverageVerificationMethod: "CUTOFF", oldestObservedAt: new Date(cutoff.getTime() - 1_000),
      recoveryProgressPage: 4, runId: "proof", pageCount: 2, requestCount: 2 });
    expect(result.recoveryVerified).toBe(true);
    expect(mocks.updateWindows).toHaveBeenCalledWith({ where: { id: { in: ["recent"] }, status: "PENDING" },
      data: expect.objectContaining({ status: "VERIFIED", verifiedRunId: "proof", verificationMethod: "CUTOFF" }) });
    expect(mocks.createWindow).not.toHaveBeenCalled();
  });
  it("does not narrow older requirements to a newer cutoff or mark HTTP success as proof", async () => {
    const oldest = new Date(cutoff.getTime() - 3_600_000);
    mocks.findWindows.mockResolvedValue([window("oldest", oldest), window("recent")]);
    const result = await markSourceSearchSuccess(context, snapshot(), [], { lane: "BACKFILL", coverageVerified: true,
      coverageVerificationMethod: "CUTOFF", oldestObservedAt: cutoff, recoveryProgressPage: 4 });
    expect(result.recoveryVerified).toBe(false);
    expect(result.requiredCutoffAt).toEqual(oldest);
  });
  it("rejects an anchor proof collected before another window changed the frozen tail", async () => {
    const stale = snapshot(); current.coverageAnchorExternalIds = ["new-anchor"];
    const result = await markSourceSearchSuccess(context, stale, [], { lane: "BACKFILL", coverageVerified: true,
      coverageVerificationMethod: "KNOWN_TAIL", recoveryProgressPage: 4 });
    expect(result.recoveryVerified).toBe(false);
  });
  it("keeps every grouped range unresolved when the source cannot prove continuity", async () => {
    mocks.findWindows.mockResolvedValue([window("oldest"), window("recent")]);
    const result = await markSourceSearchSuccess(context, snapshot(), [], { lane: "BACKFILL",
      coverageUnresolvedReason: "UNSTABLE_PAGINATION", coverageAttemptGeneration: "current", recoveryProgressPage: 3 });
    expect(result.recoveryUnresolved).toBe(true);
    expect(mocks.updateWindows).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: "UNRESOLVED", attemptGeneration: "current", unresolvedReason: "UNSTABLE_PAGINATION", verifiedAt: null,
    }) }));
  });
});
