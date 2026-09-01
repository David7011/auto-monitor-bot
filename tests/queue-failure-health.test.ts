import { describe, expect, it } from "vitest";
import { queueFailureSummary } from "../apps/api/src/lib/queues.js";

describe("queue failure health", () => {
  it("separates recent incidents from retained BullMQ history", () => {
    expect(queueFailureSummary({
      realtime: { failed: 3, failedRecent: 0 },
      replay: { failed: 2, failedRecent: 1 },
    })).toEqual({ total: 5, recent: 1, historical: 4 });
  });
});
