import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("../scripts/backup-database.ps1", import.meta.url), "utf8");

describe("backup mirror durable retry policy", () => {
  it("attempts verified mirror delivery before coalescing a recent local backup", () => {
    const recentGuard = script.indexOf("if (!$Force -and $latest");
    const retryPublish = script.indexOf("Publish-AmbBackupMirror", recentGuard);
    const coalescedExit = script.indexOf("exit 0", recentGuard);
    expect(recentGuard).toBeGreaterThan(0);
    expect(retryPublish).toBeGreaterThan(recentGuard);
    expect(retryPublish).toBeLessThan(coalescedExit);
    expect(script.slice(recentGuard, coalescedExit)).toContain("Get-AmbBackupSet $BackupRoot");
  });
});
