import { createHash } from "node:crypto";

export type OlxCadenceExperimentConfig = {
  owner: "cadence" | "origin" | "none";
  enabled: boolean;
  baseIntervalSeconds: number;
  baseJitterSeconds: number;
  canaryIntervalSeconds: number;
  canaryJitterSeconds: number;
  qualificationRuns: number;
  promotionRuns: number;
  hotPathMinimumSamples: number;
  p95MinimumSamples: number;
  p99MinimumSamples: number;
  qualificationMaximumP95Ms: number;
  maximumP95Ms: number;
  p95GrowthPercent: number;
  queueDepthLimit: number;
};

export type OlxCadenceExperimentDescriptor = {
  experimentId: string;
  codeRevision: string;
  configHash: string;
  configSnapshot: OlxCadenceExperimentConfig;
};

export function buildOlxCadenceExperimentDescriptor(input: {
  config: OlxCadenceExperimentConfig;
  codeRevision?: string;
  startedAt: Date;
}): OlxCadenceExperimentDescriptor {
  const codeRevision = normalizeRevision(input.codeRevision);
  const serializedConfig = JSON.stringify(input.config);
  const configHash = createHash("sha256").update(serializedConfig).digest("hex");
  const identityHash = createHash("sha256")
    .update(`${codeRevision}\n${serializedConfig}`)
    .digest("hex")
    .slice(0, 12);
  const timestamp = input.startedAt.toISOString().replace(/\D/gu, "").slice(0, 14);
  return {
    experimentId: `olx-cadence-${timestamp}-${identityHash}`,
    codeRevision,
    configHash,
    configSnapshot: input.config,
  };
}

export function isSameOlxCadenceExperiment(
  persisted: { experimentId: string | null; codeRevision: string | null; configHash: string | null },
  candidate: OlxCadenceExperimentDescriptor,
): boolean {
  return Boolean(persisted.experimentId)
    && persisted.codeRevision === candidate.codeRevision
    && persisted.configHash === candidate.configHash;
}

function normalizeRevision(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized || "unknown";
}
