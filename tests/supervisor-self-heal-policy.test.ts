import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const supervisor = readFileSync(new URL("../scripts/supervisor.ps1", import.meta.url), "utf8");
const watchdog = readFileSync(new URL("../scripts/watchdog.ps1", import.meta.url), "utf8");

describe("Windows self-heal policy", () => {
  it("does not let a long validation mutex suppress runtime liveness repair", () => {
    expect(supervisor).not.toContain("Test-LockHeld $ValidationLockPath");
    expect(watchdog).not.toContain("Test-LockHeld $ValidationLockPath");
    expect(supervisor).toContain("Test-LockHeld $StartLockPath");
  });

  it("targets an unresponsive API event loop even while its PID remains alive", () => {
    expect(supervisor).toContain("function Test-ApiLiveness");
    expect(supervisor).toContain('$staleApiServices');
    expect(supervisor).toContain('@("api")');
    expect(supervisor).toContain('$fastRecoveryArguments += $targetedRestartServices');
  });

  it("keeps dependency readiness separate from process and event-loop liveness", () => {
    expect(supervisor.indexOf("Test-ApiLiveness")).toBeLessThan(supervisor.indexOf("$ReadinessScript -TimeoutSeconds 3"));
    expect(supervisor).toContain("$ConsecutiveReadinessFailuresBeforeRecovery");
  });
});
