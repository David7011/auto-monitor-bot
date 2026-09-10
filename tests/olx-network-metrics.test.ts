import { describe, expect, it } from "vitest";
import {
  OlxNetworkMetrics,
  parseOlxNetworkSamples,
  summarizeOlxNetworkSamples,
} from "../apps/worker/src/collectors/olx-network-metrics.js";

describe("OLX network metrics", () => {
  it("stores bounded non-sensitive samples and computes nearest-rank tails", () => {
    const metrics = new OlxNetworkMetrics();
    for (let index = 1; index <= 60; index += 1) {
      metrics.record({
        connectionReused: index > 1,
        dispatcherWaitMs: index,
        connectionSetupMs: index === 1 ? 25 : 0,
        wireTtfbMs: index * 2,
        downloadMs: index * 3,
        responseBytes: index * 100,
      });
    }
    const coverage = metrics.coverageMetrics();
    const samples = parseOlxNetworkSamples(coverage.olxNetworkSamplesJson);
    const summary = summarizeOlxNetworkSamples(samples);

    expect(coverage.olxNetworkSamples).toBe(60);
    expect(samples).toHaveLength(50);
    expect(summary.dispatcherWaitMs).toEqual({ samples: 50, p50: 35, p95: 58, p99: 60 });
    expect(summary.connectionReuse.percent).toBe(100);
    expect(JSON.stringify(coverage)).not.toContain("http");
  });

  it("rejects malformed and negative values", () => {
    expect(parseOlxNetworkSamples("not-json")).toEqual([]);
    expect(parseOlxNetworkSamples(JSON.stringify([
      { wireTtfbMs: -1, responseBytes: "secret", connectionReused: false },
    ]))).toEqual([{ connectionReused: false }]);
  });
});
