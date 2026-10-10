import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  windowFindUnique: vi.fn(),
  windowFindFirst: vi.fn(),
  windowUpdate: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../packages/db/src/index.js", () => ({
  prisma: {
    coverageRecoveryWindow: {
      findUnique: mocks.windowFindUnique,
      findFirst: mocks.windowFindFirst,
      update: mocks.windowUpdate,
    },
  },
}));
vi.mock("../apps/worker/src/lib/log.js", () => ({
  log: { warn: mocks.logWarn },
}));

import {
  markRecoveryUnresolvedAlerted,
  shouldSendRecoveryUnresolvedAlert,
} from "../apps/worker/src/modules/recovery-unresolved-alert.js";

const base = {
  sourceSearchStateId: "state-1",
  windowId: "window-new",
  unresolvedReason: "UNSTABLE_PAGINATION" as const,
};

describe("recovery unresolved alert gate", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.windowFindUnique.mockResolvedValue({ acknowledgedAt: null });
    mocks.windowFindFirst.mockResolvedValue(null);
    mocks.windowUpdate.mockResolvedValue({});
    mocks.logWarn.mockResolvedValue(undefined);
  });

  it("alerts on the first unresolved window for a state and reason", async () => {
    const result = await shouldSendRecoveryUnresolvedAlert(base);

    expect(result).toBe(true);
  });

  it("suppresses a repeat for an already-notified state and reason", async () => {
    const notifiedAt = new Date(Date.now() - 60 * 60 * 1000);
    mocks.windowFindFirst
      .mockResolvedValueOnce({ unresolvedAt: notifiedAt, acknowledgedAt: notifiedAt })
      .mockResolvedValueOnce(null);

    const result = await shouldSendRecoveryUnresolvedAlert(base);

    expect(result).toBe(false);
  });

  it("suppresses even long after the notification while still unresolved", async () => {
    const notifiedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    mocks.windowFindFirst
      .mockResolvedValueOnce({ unresolvedAt: notifiedAt, acknowledgedAt: notifiedAt })
      .mockResolvedValueOnce(null);

    const result = await shouldSendRecoveryUnresolvedAlert(base);

    expect(result).toBe(false);
  });

  it("alerts again when a window was verified after the last notification", async () => {
    const notifiedAt = new Date(Date.now() - 60 * 60 * 1000);
    mocks.windowFindFirst
      .mockResolvedValueOnce({ unresolvedAt: notifiedAt, acknowledgedAt: notifiedAt })
      .mockResolvedValueOnce({ id: "window-verified" });

    const result = await shouldSendRecoveryUnresolvedAlert(base);

    expect(result).toBe(true);
  });

  it("scopes the repeat check to the same reason", async () => {
    const notifiedAt = new Date(Date.now() - 60 * 60 * 1000);
    mocks.windowFindFirst
      .mockResolvedValueOnce({ unresolvedAt: notifiedAt, acknowledgedAt: notifiedAt })
      .mockResolvedValueOnce(null);

    const result = await shouldSendRecoveryUnresolvedAlert({
      ...base,
      windowId: "window-other-reason",
      unresolvedReason: "PUBLIC_OFFSET_CAP",
    });

    expect(mocks.windowFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ unresolvedReason: "PUBLIC_OFFSET_CAP" }),
    }));
    expect(result).toBe(false);
  });

  it("suppresses when the current window was already acknowledged", async () => {
    mocks.windowFindUnique.mockResolvedValueOnce({ acknowledgedAt: new Date() });

    const result = await shouldSendRecoveryUnresolvedAlert(base);

    expect(result).toBe(false);
    expect(mocks.windowFindFirst).not.toHaveBeenCalled();
  });

  it("fails open when the database is unavailable", async () => {
    mocks.windowFindUnique.mockRejectedValueOnce(new Error("connection lost"));

    const result = await shouldSendRecoveryUnresolvedAlert(base);

    expect(result).toBe(true);
  });

  it("alerts when the reason is missing", async () => {
    const result = await shouldSendRecoveryUnresolvedAlert({ ...base, unresolvedReason: null });

    expect(result).toBe(true);
    expect(mocks.windowFindUnique).not.toHaveBeenCalled();
  });

  it("marks the window acknowledged after sending", async () => {
    await markRecoveryUnresolvedAlerted({ windowId: "window-new", unresolvedReason: "UNSTABLE_PAGINATION" });

    expect(mocks.windowUpdate).toHaveBeenCalledWith({
      where: { id: "window-new" },
      data: expect.objectContaining({
        acknowledgedBy: "system-alert",
        acknowledgementNote: "UNSTABLE_PAGINATION",
      }),
    });
  });

  it("never throws from the acknowledgement path", async () => {
    mocks.windowUpdate.mockRejectedValueOnce(new Error("connection lost"));

    await expect(markRecoveryUnresolvedAlerted({ windowId: "window-new", unresolvedReason: "UNSTABLE_PAGINATION" })).resolves.toBeUndefined();
  });
});
