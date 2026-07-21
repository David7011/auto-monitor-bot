import { afterEach, describe, expect, it, vi } from "vitest";
import { intervalWithJitterMs } from "../packages/shared/src/utils/jitter.js";

describe("monitoring interval jitter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("preserves configured realtime intervals below ten seconds", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(intervalWithJitterMs(5, 0)).toBe(5_000);
  });

  it("never schedules a zero or negative delay", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(intervalWithJitterMs(2, 10)).toBe(1_000);
  });
});
