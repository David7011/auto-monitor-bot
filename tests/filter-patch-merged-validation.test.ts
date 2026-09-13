import { createRequire } from "node:module";
const Fastify = createRequire(new URL("../apps/api/package.json", import.meta.url))("fastify");
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ existing: vi.fn(), update: vi.fn(), transaction: vi.fn() }));
vi.mock("../packages/db/src/index.js", () => ({ Prisma: {}, prisma: { $transaction: mocks.transaction } }));
vi.mock("../apps/api/src/lib/queues.js", () => ({ enqueue: vi.fn() }));
vi.mock("../apps/api/src/modules/filter-state-hygiene.js", () => ({ compactFilterSearchStates: vi.fn() }));
import { filtersRoutes } from "../apps/api/src/routes/filters.js";

describe("PATCH validates merged stored filter ranges", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.transaction.mockImplementation((operation: (tx: unknown) => Promise<unknown>) => operation({
      $executeRaw: vi.fn(), filter: { findUnique: mocks.existing, update: mocks.update, findMany: vi.fn().mockResolvedValue([]) },
    }));
  });
  it.each([
    ["yearFrom", "yearTo", 2020, 2025], ["priceFrom", "priceTo", 1000, 2000],
    ["mileageFrom", "mileageTo", 100, 200], ["engineVolumeFrom", "engineVolumeTo", 1, 2],
    ["enginePowerFrom", "enginePowerTo", 100, 200], ["doorsFrom", "doorsTo", 2, 4], ["seatsFrom", "seatsTo", 2, 4],
  ])("rejects a one-sided %s patch contradicting stored %s", async (from, to, low, high) => {
    mocks.existing.mockResolvedValue({ id: "filter-1", name: "Test", categoryKey: "vehicle.car", sources: ["OLX"], [from]: low, [to]: high });
    const app = Fastify();
    try {
      await app.register(filtersRoutes);
      const response = await app.inject({ method: "PATCH", url: "/filters/filter-1", payload: { [from]: high + 1 } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain(`${from} must be less than or equal to ${to}`);
      expect(mocks.update).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
