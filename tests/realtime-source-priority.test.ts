import { describe, expect, it } from "vitest";
import {
  OLX_REALTIME_COLLECTOR_PRIORITY,
  prioritizeRealtimeSources,
  realtimeCollectorPriority,
  SCHEDULED_SOURCES,
} from "../apps/api/src/modules/monitoring/realtime-source-priority.js";

describe("realtime source priority", () => {
  it("keeps OLX first regardless of database result order", () => {
    const sources = prioritizeRealtimeSources([
      { source: "RST", id: "rst" },
      { source: "AUTO_RIA", id: "ria" },
      { source: "OLX", id: "olx" },
    ]);

    expect(SCHEDULED_SOURCES[0]).toBe("OLX");
    expect(sources.map((source) => source.id)).toEqual(["olx", "ria", "rst"]);
  });

  it("assigns an explicit highest queue priority only to OLX realtime", () => {
    expect(realtimeCollectorPriority("OLX")).toBe(OLX_REALTIME_COLLECTOR_PRIORITY);
    expect(realtimeCollectorPriority("AUTO_RIA")).toBeUndefined();
  });
});
