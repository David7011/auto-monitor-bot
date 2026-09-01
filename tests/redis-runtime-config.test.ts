import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("latency-critical Redis runtime configuration", () => {
  it("keeps AOF recovery while disabling measured RDB fork stalls", () => {
    const source = readFileSync(path.resolve("scripts/start.ps1"), "utf8");

    expect(source).toContain("appendonly yes");
    expect(source).toContain("appendfsync everysec");
    expect(source).toContain('save ""');
    expect(source).toContain("latency-monitor-threshold 25");
    expect(source).toContain("maxmemory-policy noeviction");
  });
});
