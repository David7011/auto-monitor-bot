import { closeDatabase, prisma } from "@amb/db";
import { summarizeJournalLatencies } from "@amb/shared";

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
      firstByteAt: true,
      bodyReceivedAt: true,
      parsedAt: true,
      hotCandidateAt: true,
      journalPersistedAt: true,
      filterCompletedAt: true,
      dispatchAttemptedAt: true,
      telegramRequestedAt: true,
      telegramAcceptedAt: true,
      },
    });
  const monitoringState = await prisma.monitoringState.findUnique({ where: { id: "singleton" } });
  const completeAcceptedObservations = legacySchema ? [] : observations.filter(isCompleteChronologicalHotPath);
  const qualificationCompleteAcceptedHotPathSamples = monitoringState
    ? completeAcceptedObservations.filter((sample) => sample.firstSeenAt >= monitoringState.olxCanaryQualificationStartedAt).length
    : 0;
  console.log(JSON.stringify({
    generatedAt: until,
    since,
    source: "OLX",
    lane: "REALTIME",
    observations: observations.length,
    completeAcceptedHotPathSamples: completeAcceptedObservations.length,
    qualificationCompleteAcceptedHotPathSamples,
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
    stages: summarizeJournalLatencies(observations),
    completeAcceptedStages: summarizeJournalLatencies(completeAcceptedObservations),
  }, null, 2));
} finally {
  await closeDatabase();
}

function isCompleteChronologicalHotPath(sample: {
  requestStartedAt: Date | null;
  firstByteAt: Date | null;
  bodyReceivedAt?: Date | null;
  parsedAt?: Date | null;
  hotCandidateAt: Date | null;
  journalPersistedAt: Date | null;
  telegramRequestedAt: Date | null;
  telegramAcceptedAt: Date | null;
}): boolean {
  const timestamps = [
    sample.requestStartedAt,
    sample.firstByteAt,
    sample.bodyReceivedAt,
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
