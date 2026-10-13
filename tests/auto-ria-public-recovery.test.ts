import { describe, expect, it, vi } from "vitest";
import { autoRiaPublicOutage, collectPublicRecovery, publicRecoveryCursor } from "../apps/worker/src/collectors/auto-ria-public-recovery.js";

const urls = ["https://auto.ria.com/uk/search/?size=20"];
const base = { urls, anchors: new Set<string>(), maxRequests: 3, canContinue: () => true };
const pageIds = (page: number) => Array.from({ length: 20 }, (_, i) => String(page * 20 + i));

describe("AUTO.RIA public durable catch-up", () => {
  it("detects a real pause from the persisted realtime boundary, not scan completion", () => {
    const boundary = new Date("2026-10-13T12:00:00Z");
    const input = { lastSuccessfulScanAt: boundary, intervalSeconds: 60, jitterSeconds: 5 };
    expect(autoRiaPublicOutage({ ...input, startedAt: new Date(boundary.getTime() + 65_000) })).toBe(false);
    expect(autoRiaPublicOutage({ ...input, startedAt: new Date(boundary.getTime() + 131_000) })).toBe(true);
    expect(autoRiaPublicOutage({ ...input, lastSuccessfulScanAt: undefined, startedAt: new Date() })).toBe(false);
  });
  it("resumes beyond page three with overlap instead of restarting from page zero", async () => {
    const ingest = vi.fn(async (url: string) => ({ ids: pageIds(Number(new URL(url).searchParams.get("page"))), complete: true }));
    const first = await collectPublicRecovery({ ...base, ingest });
    expect(first.cursor.feeds[0]?.nextPage).toBe(3);
    ingest.mockClear();
    const second = await collectPublicRecovery({ ...base, ingest, cursor: JSON.parse(JSON.stringify(first.cursor)) });
    expect(ingest.mock.calls.map(([url]) => new URL(url).searchParams.get("page"))).toEqual(["2", "3", "4"]);
    expect(second.cursor.feeds[0]?.nextPage).toBe(5);
  });
  it("gives saved feeds their own cursor and does not starve them behind the primary feed", async () => {
    const result = await collectPublicRecovery({ ...base, urls: [...urls, "https://auto.ria.com/uk/search/?brand.id=1"],
      ingest: async url => ({ ids: pageIds(Number(new URL(url).searchParams.get("page"))), complete: true }) });
    expect(result.cursor.feeds.map(feed => feed.nextPage)).toEqual([2, 1]);
    expect(result.cursor.feedIndex).toBe(1);
  });
  it("restarts a shifted offset without claiming full coverage", async () => {
    const cursor = publicRecoveryCursor(undefined, urls);
    cursor.feeds[0]!.nextPage = 4; cursor.feeds[0]!.overlapIds = ["old"];
    const result = await collectPublicRecovery({ ...base, cursor, ingest: async () => ({ ids: ["shifted"], complete: true }) });
    expect(result.cursor.feeds[0]?.nextPage).toBe(0);
    expect(result.noProgressReason).toBe("PUBLIC_OVERLAP_MOVED");
    expect(result.progressed).toBe(0);
  });
  it("does not advance a page with budget overflow or malformed candidates", async () => {
    const result = await collectPublicRecovery({ ...base, ingest: async () => ({ ids: ["1"], complete: false }) });
    expect(result.cursor.feeds[0]?.nextPage).toBe(0);
    expect(result.noProgressReason).toBe("PUBLIC_PAGE_INCOMPLETE");
  });
  it("does not use one promoted known ID to stop depth recovery", async () => {
    const result = await collectPublicRecovery({ ...base, anchors: new Set(["0"]),
      ingest: async url => ({ ids: pageIds(Number(new URL(url).searchParams.get("page"))), complete: true }) });
    expect(result.cursor.feeds[0]?.nextPage).toBe(3);
    expect(result.reason).toBeUndefined();
  });
  it("marks broad anchor overlap unresolved because public order is not proven", async () => {
    const result = await collectPublicRecovery({ ...base, anchors: new Set(pageIds(0)),
      ingest: async () => ({ ids: pageIds(0), complete: true }) });
    expect(result.reason).toBe("NON_PARTITIONABLE_RANGE");
    expect(result.cursor.feeds[0]?.reason).toBe("ANCHOR_OVERLAP_UNPROVEN_ORDER");
  });
  it("terminates repeated pagination with an honest unresolved reason", async () => {
    const result = await collectPublicRecovery({ ...base, ingest: async () => ({ ids: pageIds(0), complete: true }) });
    expect(result.reason).toBe("UNSTABLE_PAGINATION");
  });
  it("stops requests on protection or deadline without advancing the cursor", async () => {
    const ingest = vi.fn(async () => ({ ids: [], complete: false, blocked: true }));
    const blocked = await collectPublicRecovery({ ...base, ingest });
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(blocked.progressed).toBe(0);
    ingest.mockClear();
    await collectPublicRecovery({ ...base, canContinue: () => false, ingest });
    expect(ingest).not.toHaveBeenCalled();
  });
  it("resets stale cursor when the saved feed configuration changes", () => {
    const cursor = publicRecoveryCursor(undefined, urls);
    cursor.feeds[0]!.nextPage = 8;
    expect(publicRecoveryCursor(cursor, ["https://auto.ria.com/uk/search/?new=1"]).feeds[0]?.nextPage).toBe(0);
  });
  it("marks an empty page done without claiming proven coverage", async () => {
    const ingest = vi.fn(async () => ({ ids: [] as string[], complete: true }));
    const result = await collectPublicRecovery({ ...base, ingest });
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(result.cursor.feeds[0]).toMatchObject({ nextPage: 0, done: true, reason: "EMPTY_PUBLIC_PAGE_UNPROVEN" });
    expect(result.reason).toBe("NON_PARTITIONABLE_RANGE");
  });
  it("stops at the local depth budget instead of walking forever", async () => {
    const cursor = publicRecoveryCursor(undefined, urls);
    cursor.feeds[0]!.nextPage = 49;
    cursor.feeds[0]!.overlapIds = pageIds(48);
    const ingest = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return { ids: pageIds(page), complete: true };
    });
    const result = await collectPublicRecovery({ ...base, cursor, ingest });
    expect(result.cursor.feeds[0]).toMatchObject({ done: true, reason: "LOCAL_DEPTH_BUDGET" });
    expect(result.cursor.feeds[0]?.nextPage).toBeLessThanOrEqual(50);
  });
  it("loses nothing when a sticky advert repeats on every page", async () => {
    const seen = new Set<string>();
    const ingest = vi.fn(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page"));
      const ids = page < 2 ? ["0", ...pageIds(page)] : [];
      for (const id of ids) seen.add(id);
      return { ids, complete: true };
    });
    const first = await collectPublicRecovery({ ...base, ingest });
    expect(first.cursor.feeds[0]?.nextPage).toBe(2);
    const second = await collectPublicRecovery({ ...base, ingest,
      cursor: JSON.parse(JSON.stringify(first.cursor)) });
    expect(second.cursor.feeds[0]?.done).toBe(true);
    expect(seen.size).toBe(40);
    expect(seen.has("0")).toBe(true);
  });
});
