import { describe, expect, it } from "vitest";
import { sourceProtectionHealth } from "../apps/api/src/lib/source-protection-health.js";

describe("source protection health", () => {
  it("keeps the project operational when a secondary source has a CAPTCHA", () => {
    expect(sourceProtectionHealth({
      olx: { enabled: true, status: "ACTIVE", paused: false },
      secondaryCaptcha: 1,
      secondaryRateLimited: 0,
      secondaryPaused: 1,
    }).status).toBe("WARN");
  });

  it("fails when the primary OLX source is blocked", () => {
    const result = sourceProtectionHealth({
      olx: {
        enabled: true,
        status: "CAPTCHA_DETECTED",
        paused: true,
        pausedUntil: new Date("2026-08-23T15:00:00Z"),
      },
      secondaryCaptcha: 0,
      secondaryRateLimited: 0,
      secondaryPaused: 0,
    });
    expect(result.status).toBe("FAIL");
    expect(result.message).toContain("2026-08-23T15:00:00.000Z");
  });

  it("is healthy when OLX and secondary sources are unrestricted", () => {
    expect(sourceProtectionHealth({
      olx: { enabled: true, status: "ACTIVE", paused: false },
      secondaryCaptcha: 0,
      secondaryRateLimited: 0,
      secondaryPaused: 0,
    }).status).toBe("OK");
  });
});
