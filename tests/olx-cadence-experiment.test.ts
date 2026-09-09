import { describe, expect, it } from "vitest";
import {
  buildOlxCadenceExperimentDescriptor,
  isSameOlxCadenceExperiment,
  type OlxCadenceExperimentConfig,
} from "../apps/api/src/modules/monitoring/olx-cadence-experiment.js";

const config: OlxCadenceExperimentConfig = {
  owner: "cadence",
  enabled: true,
  baseIntervalSeconds: 20,
  baseJitterSeconds: 4,
  canaryIntervalSeconds: 18,
  canaryJitterSeconds: 3,
  qualificationRuns: 100,
  promotionRuns: 100,
  hotPathMinimumSamples: 30,
  p95MinimumSamples: 30,
  p99MinimumSamples: 100,
  qualificationMaximumP95Ms: 8_000,
  maximumP95Ms: 12_000,
  p95GrowthPercent: 125,
  queueDepthLimit: 25,
};

describe("OLX cadence experiment identity", () => {
  it("binds an experiment to the exact revision and effective configuration", () => {
    const descriptor = buildOlxCadenceExperimentDescriptor({
      config,
      codeRevision: "abc123",
      startedAt: new Date("2026-09-09T20:15:30.000Z"),
    });
    expect(descriptor.experimentId).toMatch(/^olx-cadence-20260909201530-[a-f0-9]{12}$/u);
    expect(descriptor.codeRevision).toBe("abc123");
    expect(descriptor.configSnapshot).toEqual(config);
    expect(descriptor.configHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("starts a new experiment when code or effective configuration changes", () => {
    const original = buildOlxCadenceExperimentDescriptor({ config, codeRevision: "rev-a", startedAt: new Date(0) });
    const newCode = buildOlxCadenceExperimentDescriptor({ config, codeRevision: "rev-b", startedAt: new Date(1) });
    const newConfig = buildOlxCadenceExperimentDescriptor({
      config: { ...config, canaryIntervalSeconds: 17 },
      codeRevision: "rev-a",
      startedAt: new Date(2),
    });
    expect(isSameOlxCadenceExperiment({
      experimentId: original.experimentId,
      codeRevision: original.codeRevision,
      configHash: original.configHash,
    }, original)).toBe(true);
    expect(isSameOlxCadenceExperiment({
      experimentId: original.experimentId,
      codeRevision: original.codeRevision,
      configHash: original.configHash,
    }, newCode)).toBe(false);
    expect(isSameOlxCadenceExperiment({
      experimentId: original.experimentId,
      codeRevision: original.codeRevision,
      configHash: original.configHash,
    }, newConfig)).toBe(false);
  });
});
