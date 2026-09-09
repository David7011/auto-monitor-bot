import { describe, expect, it } from "vitest";
import { defaultSourceDefinitions } from "../apps/api/src/modules/monitoring/orchestrator.js";

describe("mock source defaults", () => {
  it("keeps MOCK disabled when MOCK_SOURCE_ENABLED=false", () => {
    const defaults = defaultSourceDefinitions({
      AUTO_RIA_API_KEY: "",
      MOCK_SOURCE_ENABLED: false,
      MONITOR_INTERVAL_SECONDS: 120,
    });
    expect(defaults.find((source) => source.source === "MOCK")?.enabled).toBe(false);
  });

  it("enables MOCK only when explicitly configured", () => {
    const defaults = defaultSourceDefinitions({
      AUTO_RIA_API_KEY: "",
      MOCK_SOURCE_ENABLED: true,
      MONITOR_INTERVAL_SECONDS: 120,
    });
    expect(defaults.find((source) => source.source === "MOCK")?.enabled).toBe(true);
  });

  it("keeps AUTO_RIA public discovery available without an API key", () => {
    const defaults = defaultSourceDefinitions({
      AUTO_RIA_API_KEY: "",
      MOCK_SOURCE_ENABLED: false,
      MONITOR_INTERVAL_SECONDS: 120,
    });
    expect(defaults.find((source) => source.source === "AUTO_RIA")?.enabled).toBe(true);
  });
});
