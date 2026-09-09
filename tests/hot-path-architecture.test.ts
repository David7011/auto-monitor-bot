import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const detectedSource = readFileSync(
  new URL("../apps/worker/src/processors/listing-detected.ts", import.meta.url),
  "utf8",
);
const enrichSource = readFileSync(
  new URL("../apps/worker/src/processors/listing-enrich.ts", import.meta.url),
  "utf8",
);

describe("notification hot-path architecture", () => {
  it("keeps heuristic possible-duplicate lookup after first delivery", () => {
    expect(detectedSource).not.toContain("findPossibleDuplicate(");
    expect(enrichSource).toContain("findPossibleDuplicate(");
  });

  it("reuses the durable upsert result for retained dedupe on fresh observations", () => {
    expect(detectedSource).toContain("persistedState = await recordPendingObservation(");
    expect(detectedSource).toContain("persistedState ?? await prisma.sourceSeenListing.findUnique(");
  });
});
