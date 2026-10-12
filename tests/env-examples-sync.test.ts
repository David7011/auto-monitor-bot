import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readText(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const workerEnv = readText("../apps/worker/src/env.ts");

function workerEnvKeys(): string[] {
  const keys = new Set<string>();
  for (const match of workerEnv.matchAll(/(?:numberEnv|booleanEnv|stringEnv)\("([A-Z0-9_]+)"/g)) {
    keys.add(match[1]!);
  }
  for (const match of workerEnv.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
    keys.add(match[1]!);
  }
  return [...keys].sort();
}

const examples = [
  "../.env.example",
  "../.env.windows.example",
  "../.env.docker.example",
];

/**
 * Env examples are the operator's only map of the 130+ worker knobs. Every
 * key readable in env.ts must exist in every example file, or a fresh deploy
 * silently runs on defaults while the operator believes it is configured.
 */
describe("env examples stay in sync with worker env", () => {
  it("covers every worker env key in all three examples", () => {
    const keys = workerEnvKeys();
    expect(keys.length).toBeGreaterThan(100);
    for (const example of examples) {
      const text = readText(example);
      const missing = keys.filter((key) => !new RegExp(`^${key}=`, "m").test(text));
      expect(`${example} missing: ${missing.join(",")}`).toBe(`${example} missing: `);
    }
  });

  it("contains no phantom keys the code never reads", () => {
    for (const example of examples) {
      expect(readText(example)).not.toMatch(/^OLX_OUTAGE_DETECTION_SECONDS=/m);
    }
  });
});
