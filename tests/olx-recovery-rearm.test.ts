import { beforeEach, describe, expect, it, vi } from "vitest";
import { olxRecoveryAttemptGeneration } from "../packages/shared/src/utils/olx-recovery.js";

const mocks = vi.hoisted(() => ({ findWindows: vi.fn(), updateWindows: vi.fn(), findState: vi.fn(),
  updateState: vi.fn(), lock: vi.fn(), transaction: vi.fn(), log: vi.fn() }));
vi.mock("../packages/db/src/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../packages/db/src/index.js")>(),
  prisma: { coverageRecoveryWindow: { findMany: mocks.findWindows }, $transaction: mocks.transaction },
}));
vi.mock("../apps/api/src/lib/queues.js", () => ({ enqueue: vi.fn() }));
vi.mock("../apps/api/src/lib/error-log.js", () => ({ logInfo: mocks.log, logWarn: mocks.log, logError: mocks.log }));
import { rearmOlxRecoveryForChangedCapability } from "../apps/api/src/modules/monitoring/orchestrator.js";
import { env } from "../apps/api/src/env.js";

const now = new Date("2026-10-12T12:00:00Z");
const generation = olxRecoveryAttemptGeneration({ pageSize: env.OLX_API_PAGE_SIZE, maxOffset: env.OLX_API_MAX_OFFSET });
type Window = { id: string; sourceSearchStateId: string; requiredCutoffAt: Date;
  status: string; attemptGeneration: string | null; overlapExternalIds: string[] };
let windows: Window[];
function window(id: string, hours: number, shard = "active"): Window {
  return { id, sourceSearchStateId: shard, requiredCutoffAt: new Date(now.getTime() - hours * 3_600_000),
    status: "UNRESOLVED", attemptGeneration: "old-generation", overlapExternalIds: [] };
}
beforeEach(() => {
  vi.clearAllMocks(); windows = [];
  mocks.findWindows.mockImplementation(async ({ where }: { where: { sourceSearchStateId?: string } }) =>
    where.sourceSearchStateId ? windows.filter((item) => item.sourceSearchStateId === where.sourceSearchStateId) : windows);
  mocks.findState.mockResolvedValue({ coverageRecoveryCutoffAt: null });
  mocks.updateWindows.mockImplementation(async ({ where, data }: { where: { id: { in: string[] } }; data: Partial<Window> }) => {
    const selected = windows.filter((item) => where.id.in.includes(item.id));
    selected.forEach((item) => Object.assign(item, data)); return { count: selected.length };
  });
  mocks.transaction.mockImplementation(async (operation: (tx: unknown) => unknown) => operation({
    $queryRaw: mocks.lock, sourceSearchState: { findUnique: mocks.findState, update: mocks.updateState },
    coverageRecoveryWindow: { findMany: mocks.findWindows, updateMany: mocks.updateWindows },
  }));
});

describe("OLX capability retry groups", () => {
  it("rearms hundreds of overlapping rows once per active shard, preserving the oldest cutoff", async () => {
    windows = Array.from({ length: 400 }, (_, index) => window(`old-${index}`, index + 1));
    windows.push({ ...window("pending", 1), status: "PENDING", attemptGeneration: null });
    expect(await rearmOlxRecoveryForChangedCapability(now)).toBe(401);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.lock).toHaveBeenCalledOnce();
    expect(mocks.updateState).toHaveBeenCalledWith({ where: { id: "active" }, data: expect.objectContaining({
      coverageRecoveryCutoffAt: new Date(now.getTime() - 400 * 3_600_000), coverageAnchorExternalIds: [],
      recoveryProgressPage: 1, recoveryNextAttemptAt: now,
    }) });
    expect(windows.every((item) => item.status === "PENDING" && item.attemptGeneration === generation)).toBe(true);
    expect(await rearmOlxRecoveryForChangedCapability(now)).toBe(0);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.findWindows).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      state: { lastSuccessfulScanAt: { gte: new Date(now.getTime() - 15 * 60_000) } },
    }) }));
  });
  it("does not reset a modern pending cursor or retry a current-generation unresolved window", async () => {
    windows = [{ ...window("pending", 1), status: "PENDING", attemptGeneration: generation,
      overlapExternalIds: ["olx-offset-evidence-v2"] }, { ...window("unreachable", 24), attemptGeneration: generation }];
    expect(await rearmOlxRecoveryForChangedCapability(now)).toBe(0);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("rebuilds legacy pending evidence and isolates separate shards", async () => {
    windows = [{ ...window("legacy", 2), status: "PENDING", attemptGeneration: null,
      overlapExternalIds: ["olx-offset-evidence-v1"] }, window("other", 3, "other-scope")];
    expect(await rearmOlxRecoveryForChangedCapability(now)).toBe(2);
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.updateState.mock.calls.map((call) => call[0].where.id)).toEqual(["active", "other-scope"]);
  });
});
