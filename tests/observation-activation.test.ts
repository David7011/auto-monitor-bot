import { describe, expect, it } from "vitest";
import { classifyObservationActivation } from "../apps/api/src/lib/observation-activation.js";

describe("initial sync observation semantics", () => {
  const activatedAt = new Date("2026-09-12T08:00:00Z");

  it("distinguishes intentionally observed existing inventory", () => {
    expect(classifyObservationActivation(new Date("2026-09-12T07:59:59Z"), [activatedAt]))
      .toBe("OBSERVED_EXISTING");
  });

  it("does not reinterpret a later restart as a new initial sync", () => {
    expect(classifyObservationActivation(new Date("2026-09-12T09:00:00Z"), [activatedAt]))
      .toBe("NEW_AFTER_ACTIVATION");
  });

  it("reports unknown instead of inventing an activation boundary", () => {
    expect(classifyObservationActivation(new Date("2026-09-12T09:00:00Z"), [null]))
      .toBe("ACTIVATION_UNKNOWN");
  });
});
