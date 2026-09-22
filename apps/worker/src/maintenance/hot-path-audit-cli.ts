import { closeDatabase, prisma } from "@amb/db";
import { qualifyMetricSummary, summarizeJournalLatencies } from "@amb/shared";
import {
  parseOlxNetworkSamples,
  summarizeOlxNetworkSamples,
} from "../collectors/olx-network-metrics.js";
import type { SourceNetworkTelemetry } from "../collectors/source-http-network-telemetry.js";
import { qualificationEvidence, selectQualificationSamples } from "./hot-path-qualification.js";

const hoursArgument = process.argv.slice(2).find((value) => /^\d+$/u.test(value));
const hours = Math.max(1, Math.min(24 * 30, Number(hoursArgument ?? 24)));
const legacySchema = process.argv.includes("--legacy-schema");
const until = new Date();
const since = new Date(until.getTime() - hours * 60 * 60 * 1_000);

try {
  const common = {
    where: {
      source: "OLX",
      discoveryLane: "REALTIME",
      firstSeenAt: { gte: since, lte: until },
    },
  } as const;
  const observations = legacySchema
    ? await prisma.sourceSeenListing.findMany({
      ...common,
      select: {
        source: true,
        publishedAt: true,
        firstSeenAt: true,
        notifiedAt: true,
        timestampConfidence: true,
        requestStartedAt: true,
        firstByteAt: true,
        hotCandidateAt: true,
        journalPersistedAt: true,
        filterCompletedAt: true,
        dispatchAttemptedAt: true,
        telegramRequestedAt: true,
        telegramAcceptedAt: true,
      },
    })
    : await prisma.sourceSeenListing.findMany({
      ...common,
      select: {
      source: true,
      publishedAt: true,
      firstSeenAt: true,
      notifiedAt: true,
      timestampConfidence: true,
      requestStartedAt: true,
      originQueuedAt: true,
      originAdmittedAt: true,
      firstByteAt: true,
      bodyReceivedAt: true,
      bodyDecodedAt: true,
      parsedAt: true,
      hotCandidateAt: true,
      journalPersistedAt: true,
      filterCompletedAt: true,
      dispatchAttemptedAt: true,
      telegramRequestedAt: true,
      telegramAcceptedAt: true,
      normalizedData: true,
      },
    });
  const collectorRuns = legacySchema ? [] : await prisma.collectorRun.findMany({
    where: {
      source: "OLX",
      lane: "REALTIME",
      startedAt: { gte: since, lte: until },
    },
    select: { coverageMetrics: true },
  });
  const monitoringState = await prisma.monitoringState.findUnique({ where: { id: "singleton" } });
  const completeAcceptedObservations = legacySchema ? [] : observations.filter(isCompleteChronologicalHotPath);
  const collectorNetworkSamples = collectorRuns.flatMap((run) => networkSamplesFromCoverageMetrics(run.coverageMetrics));
  const acceptedListingNetworkSamples = completeAcceptedObservations.flatMap((observation) =>
    networkSampleFromNormalizedData("normalizedData" in observation ? observation.normalizedData : undefined));
  const qualificationCompleteAcceptedObservations = selectQualificationSamples(
    completeAcceptedObservations,
    monitoringState?.olxCanaryQualificationStartedAt,
  );
  const qualificationCompleteAcceptedHotPathSamples = qualificationCompleteAcceptedObservations.length;
  const stages = summarizeJournalLatencies(observations);
  const completeAcceptedStages = summarizeJournalLatencies(completeAcceptedObservations);
  const qualificationCompleteAcceptedStages = summarizeJournalLatencies(qualificationCompleteAcceptedObservations);
  console.log(JSON.stringify({
    generatedAt: until,
    since,
    source: "OLX",
    lane: "REALTIME",
    observations: observations.length,
    completeAcceptedHotPathSamples: completeAcceptedObservations.length,
    qualificationCompleteAcceptedHotPathSamples,
    qualificationBaseline: {
      startedAt: monitoringState?.olxCanaryQualificationStartedAt ?? null,
      ...qualificationEvidence(qualificationCompleteAcceptedHotPathSamples),
      stages: qualifyStages(qualificationCompleteAcceptedStages),
    },
    cadenceCanary: monitoringState ? {
      mode: monitoringState.olxCanaryMode,
      qualificationRuns: monitoringState.olxCanaryCleanRunCount,
      canaryRuns: monitoringState.olxCanaryRunCount,
      qualificationStartedAt: monitoringState.olxCanaryQualificationStartedAt,
      canaryStartedAt: monitoringState.olxCanaryStartedAt,
      baselineP95Ms: monitoringState.olxCanaryBaselineP95Ms,
      currentP95Ms: monitoringState.olxCanaryCurrentP95Ms,
      rollbackReason: monitoringState.olxCanaryRollbackReason,
    } : null,
    legacySchema,
    stages,
    qualifiedStages: qualifyStages(stages),
    completeAcceptedStages,
    qualifiedCompleteAcceptedStages: qualifyStages(completeAcceptedStages),
    network: {
      collectorRequests: summarizeOlxNetworkSamples(collectorNetworkSamples),
      completeAcceptedListings: summarizeOlxNetworkSamples(acceptedListingNetworkSamples),
    },
  }, null, 2));
} finally {
  await closeDatabase();
}

function qualifyStages(stages: ReturnType<typeof summarizeJournalLatencies>) {
  return Object.fromEntries(Object.entries(stages).map(([name, summary]) => [name, qualifyMetricSummary(summary)]));
}

function networkSamplesFromCoverageMetrics(value: unknown): SourceNetworkTelemetry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((metric) => {
    if (!metric || typeof metric !== "object" || Array.isArray(metric)) return [];
    return parseOlxNetworkSamples((metric as Record<string, unknown>).olxNetworkSamplesJson);
  });
}

function networkSampleFromNormalizedData(value: unknown): SourceNetworkTelemetry[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const telemetry = (value as Record<string, unknown>).networkTelemetry;
  if (!telemetry || typeof telemetry !== "object" || Array.isArray(telemetry)) return [];
  return parseOlxNetworkSamples(JSON.stringify([telemetry]));
}

function isCompleteChronologicalHotPath(sample: {
  originQueuedAt?: Date | null;
  originAdmittedAt?: Date | null;
  requestStartedAt: Date | null;
  firstByteAt: Date | null;
  bodyReceivedAt?: Date | null;
  bodyDecodedAt?: Date | null;
  parsedAt?: Date | null;
  hotCandidateAt: Date | null;
  journalPersistedAt: Date | null;
  telegramRequestedAt: Date | null;
  telegramAcceptedAt: Date | null;
}): boolean {
  const timestamps = [
    sample.originQueuedAt,
    sample.originAdmittedAt,
    sample.requestStartedAt,
    sample.firstByteAt,
    sample.bodyReceivedAt,
    sample.bodyDecodedAt,
    sample.parsedAt,
    sample.hotCandidateAt,
    sample.journalPersistedAt,
    sample.telegramRequestedAt,
    sample.telegramAcceptedAt,
  ];
  if (timestamps.some((value) => value == null)) return false;
  const milliseconds = timestamps.map((value) => value!.getTime());
  return milliseconds.every((value, index) => index === 0 || value >= milliseconds[index - 1]!);
}
