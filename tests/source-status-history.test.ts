import { describe, expect, it } from "vitest";
import {
  latestActiveIncidentPerSource,
  mergeIncidentHistory,
  mergeRecentRunsBySource,
} from "../apps/api/src/lib/source-status-history.js";

describe("source status history", () => {
  it("keeps bounded histories from every source and sorts them together", () => {
    const rows = mergeRecentRunsBySource([
      [{ id: "olx", startedAt: new Date("2026-08-20T10:00:00Z") }],
      [
        { id: "cars-new", startedAt: new Date("2026-08-22T10:00:00Z") },
        { id: "cars-old", startedAt: new Date("2026-08-22T09:59:45Z") },
      ],
    ]);
    expect(rows.map((row) => row.id)).toEqual(["cars-new", "cars-old", "olx"]);
  });

  it("always keeps active incidents before resolved history without duplicates", () => {
    expect(mergeIncidentHistory(
      [{ id: "olx-active" }],
      [{ id: "olx-active" }, { id: "rst-resolved" }],
    )).toEqual([{ id: "olx-active" }, { id: "rst-resolved" }]);
  });

  it("keeps only the newest active incident for each source", () => {
    const incidents = latestActiveIncidentPerSource([
      { id: "olx-old", sourceId: "olx", updatedAt: new Date("2026-08-20T10:00:00Z") },
      { id: "rst", sourceId: "rst", updatedAt: new Date("2026-08-21T10:00:00Z") },
      { id: "olx-current", sourceId: "olx", updatedAt: new Date("2026-08-22T10:00:00Z") },
    ]);
    expect(incidents.map((incident) => incident.id)).toEqual(["olx-current", "rst"]);
  });
});
