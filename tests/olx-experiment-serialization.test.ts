import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("OLX experiment serialization contract", () => {
  it("gives cadence and origin canaries mutually exclusive ownership", () => {
    const apiEnv = readFileSync("apps/api/src/env.ts", "utf8");
    const workerEnv = readFileSync("apps/worker/src/env.ts", "utf8");
    const cadence = readFileSync("apps/api/src/modules/monitoring/olx-cadence-canary.ts", "utf8");
    const origin = readFileSync("apps/worker/src/modules/olx-request-coordinator.ts", "utf8");
    for (const source of [apiEnv, workerEnv]) {
      expect(source).toContain('OLX_EXPERIMENT_OWNER: enumEnv("OLX_EXPERIMENT_OWNER", ["cadence", "origin", "none"] as const, "cadence")');
    }
    expect(cadence).toContain('env.OLX_EXPERIMENT_OWNER === "cadence"');
    expect(origin).toContain('env.OLX_EXPERIMENT_OWNER === "origin"');
  });

  it("injects the deployed git revision into every managed process", () => {
    const start = readFileSync("scripts/start.ps1", "utf8");
    expect(start).toContain("function Set-AmbCodeRevision");
    expect(start).toContain('[Environment]::SetEnvironmentVariable("AMB_CODE_REVISION", $revision, "Process")');
    expect(start).toContain("Set-AmbCodeRevision");
  });
});
