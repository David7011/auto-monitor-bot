import { describe, expect, it } from "vitest";
import { errorLogFingerprint } from "../packages/db/src/index.js";

describe("error log fingerprint", () => {
  it("is stable for the same level, scope and message", () => {
    const first = errorLogFingerprint("ERROR", "orchestrator", "Tick failed");
    const second = errorLogFingerprint("ERROR", "orchestrator", "Tick failed");
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{32}$/u);
  });

  it("separates different severity and messages", () => {
    expect(errorLogFingerprint("ERROR", "worker", "failed"))
      .not.toBe(errorLogFingerprint("WARN", "worker", "failed"));
    expect(errorLogFingerprint("ERROR", "worker", "failed"))
      .not.toBe(errorLogFingerprint("ERROR", "worker", "recovered"));
  });
});
