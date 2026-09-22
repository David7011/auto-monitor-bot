import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function script(name: string): string {
  return readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8");
}

describe("accepted production release policy", () => {
  it("verifies the accepted release before stopping a healthy runtime", () => {
    const start = script("start.ps1");
    const assertion = start.indexOf("Assert-AmbAcceptedRelease $ProjectRoot $runtimeVersion");
    const stop = start.lastIndexOf("Stop-AppProcesses");

    expect(assertion).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(assertion);
    expect(start).toContain("accepted-release-required");
    expect(start).toContain("if ($Dev -or !$acceptedRelease)");
    expect(start).toContain("if (!$acceptedRelease)");
  });

  it("requires the same checksum-verified release for targeted recovery", () => {
    const recover = script("recover.ps1");

    expect(recover).toContain("accepted-release-required");
    expect(recover).toContain("Assert-AmbAcceptedRelease $ProjectRoot $runtimeVersion");
    expect(recover).toContain("AMB_CODE_REVISION");
    expect(recover).toContain("AMB_RELEASE_ID");
  });

  it("reports and compares manifest identity with the running API", () => {
    const status = script("status.ps1");

    expect(status).toContain("Get-AmbAcceptedRelease $ProjectRoot");
    expect(status).toContain("$health.api.codeRevision");
    expect(status).toContain("$health.api.releaseId");
    expect(status).toContain("Accepted release identity: MATCH");
  });

  it("publishes release identity from the API process environment", () => {
    const health = readFileSync(
      new URL("../apps/api/src/routes/system-health-routes.ts", import.meta.url),
      "utf8",
    );

    expect(health).toContain('codeRevision: process.env.AMB_CODE_REVISION ?? "unknown"');
    expect(health).toContain('releaseId: process.env.AMB_RELEASE_ID ?? null');
  });

  it("accepts only checksum-pinned candidate artifacts built from the same clean commit", () => {
    const release = script("accepted-release.ps1");
    const build = script("verify-production-build.ps1");
    const accept = script("accept-release.ps1");

    expect(build).toContain("New-AmbReleaseCandidateManifest $ProjectRoot $runtimeVersion");
    expect(release).toContain("New-AmbAcceptedReleaseFromCandidate");
    expect(release).toContain("Release candidate provenance does not match the current clean commit/runtime");
    expect(release).toContain("Release candidate artifact changed after build");
    expect(accept).toContain("New-AmbAcceptedReleaseFromCandidate");
    expect(accept).toContain("Restore-AmbAcceptedRelease $ProjectRoot $manifest.releaseId");
  });
});
