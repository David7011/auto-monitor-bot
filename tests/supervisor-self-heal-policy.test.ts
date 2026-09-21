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
    expect(supervisor).toContain("function Get-ApiHealthSnapshot");
    expect(supervisor).toContain('$staleApiServices');
    expect(supervisor).toContain('@("api")');
    expect(supervisor).toContain('$fastRecoveryArguments += $targetedRestartServices');
  });

  it("detects a stalled scheduler separately from HTTP liveness", () => {
    expect(supervisor).toContain("function Test-SchedulerProgress");
    expect(supervisor).toContain("function Test-SchedulerDependenciesReady");
    expect(supervisor).toContain("$Health.monitoring.lastTickAt");
    expect(supervisor).toContain("$schedulerProgressFailed");
    expect(supervisor).toContain("$apiLivenessFailed -or $schedulerProgressFailed");
  });

  it("only suppresses repair for an explicitly expiring deployment lease", () => {
    for (const script of [supervisor, watchdog]) {
      expect(script).toContain("function Test-DeploymentMaintenanceActive");
      expect(script).toContain("deployment-maintenance.json");
      expect(script).toContain("expiresAt");
      expect(script).toContain("[datetimeoffset]::Parse");
      expect(script).toContain("Test-DeploymentMaintenanceActive");
    }
  });

  it("keeps dependency readiness separate from process and event-loop liveness", () => {
    expect(supervisor.indexOf("Get-ApiHealthSnapshot")).toBeLessThan(supervisor.indexOf("$ReadinessScript -TimeoutSeconds 3"));
    expect(supervisor).toContain("Test-SchedulerDependenciesReady $apiHealthSnapshot");
    expect(supervisor).toContain("$Health.database.status -eq \"OK\"");
    expect(supervisor).toContain("$Health.redis.status -ne \"FAIL\"");
    expect(supervisor).toContain("$ConsecutiveReadinessFailuresBeforeRecovery");
  });
});
