import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ count: vi.fn(), listings: vi.fn() }));
vi.mock("../packages/db/src/index.js", () => ({
  prisma: { telegramNotification: { count: mocks.count }, listing: { count: mocks.listings } },
}));
import { getListingRetentionHealth } from "../apps/api/src/routes/system-retention-health.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.count.mockResolvedValue(0);
  mocks.listings.mockResolvedValue(0);
});

it("excludes cleared accepted receipts from legacy overdue health", async () => {
  await expect(getListingRetentionHealth(new Date("2026-10-12T12:00:00Z"))).resolves.toMatchObject({
    status: "OK", overdue: 0, invalid: 0,
  });
  const legacyQuery = mocks.count.mock.calls.find(([query]) => query.where.OR);
  expect(legacyQuery?.[0].where).toMatchObject({ retentionPolicyAppliedAt: null, messageId: { not: null } });
});
