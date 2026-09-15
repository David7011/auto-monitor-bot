export type CompletenessSeverity = "IMPOSSIBLE" | "RECOVERABLE";

export type CompletenessIssueCode =
  | "KNOWN_ID_WITHOUT_OBSERVATION"
  | "LISTING_WITHOUT_OBSERVATION"
  | "TELEGRAM_WITHOUT_LISTING"
  | "OBSERVATION_DANGLING_LISTING"
  | "NOTIFIED_WITHOUT_ACCEPTED_NOTIFICATION"
  | "DISPATCH_WITHOUT_NOTIFICATION_STATE"
  | "STALE_REPLAYABLE_OBSERVATION"
  | "BOUNDARY_AHEAD_OF_INCOMPLETE_OBSERVATION"
  | "PENDING_STATE_WITHOUT_WINDOW"
  | "PENDING_WINDOW_WITHOUT_STATE"
  | "VERIFIED_WITHOUT_EVIDENCE";

export type CompletenessFact = {
  code: CompletenessIssueCode;
  identity: string;
  detail?: string;
};

export type CompletenessFinding = CompletenessFact & {
  severity: CompletenessSeverity;
  recovery: "REPLAYABLE" | "CONTINUITY_ONLY" | null;
};

export type CompletenessFactGroup = {
  code: CompletenessIssueCode;
  totalCount: number;
  sample: readonly Omit<CompletenessFact, "code">[];
  oldestRecoverableAt?: Date | string | null;
};

export type ObservationContractInput = {
  decision: "PENDING" | "REJECTED" | "MATCHED" | "DUPLICATE" | "DISPATCHED" | "NOTIFIED" | "FAILED";
  hasNormalizedSnapshot: boolean;
  hasListing: boolean;
  listingMode?: "LIVE" | "SHADOW" | string | null;
  notificationStatus?: "PENDING" | "FLASH_PENDING" | "PROCESSING" | "RETRY_PENDING" | "SENT" | "UPDATED" | "FAILED" | null;
  notificationAccepted: boolean;
  observationAccepted?: boolean;
};

export type ObservationContractOutcome =
  | "NOTIFIED"
  | "REJECTED"
  | "DUPLICATE"
  | "SHADOWED"
  | "RECOVERY_PENDING"
  | "FAILED_REPLAYABLE"
  | "IMPOSSIBLE";

export function classifyObservationContract(input: ObservationContractInput): ObservationContractOutcome {
  if (input.decision === "NOTIFIED") {
    return input.observationAccepted
      || (input.hasListing
        && input.notificationAccepted
        && (input.notificationStatus === "SENT" || input.notificationStatus === "UPDATED"))
      ? "NOTIFIED"
      : "IMPOSSIBLE";
  }
  if (input.decision === "REJECTED") return "REJECTED";
  if (input.decision === "DUPLICATE") return "DUPLICATE";
  if (input.decision === "MATCHED" && input.hasListing && input.listingMode === "SHADOW") return "SHADOWED";
  if (!input.hasNormalizedSnapshot && !input.hasListing) return "IMPOSSIBLE";
  if (input.decision === "FAILED") return "FAILED_REPLAYABLE";
  return "RECOVERY_PENDING";
}

export function classifyCompletenessFact(fact: CompletenessFact): CompletenessFinding {
  const recovery = fact.code === "KNOWN_ID_WITHOUT_OBSERVATION"
    ? "CONTINUITY_ONLY" as const
    : fact.code === "STALE_REPLAYABLE_OBSERVATION"
      || fact.code === "BOUNDARY_AHEAD_OF_INCOMPLETE_OBSERVATION"
      ? "REPLAYABLE" as const
      : null;
  return { ...fact, severity: recovery ? "RECOVERABLE" : "IMPOSSIBLE", recovery };
}

export function summarizeCompletenessFacts(facts: readonly CompletenessFact[]) {
  const findings = facts.map(classifyCompletenessFact);
  const impossibleCount = findings.filter((finding) => finding.severity === "IMPOSSIBLE").length;
  return {
    findings,
    impossibleCount,
    recoverableCount: findings.filter((finding) => finding.severity === "RECOVERABLE").length,
    ok: impossibleCount === 0,
    clean: findings.length === 0,
  };
}

export function summarizeCompletenessGroups(groups: readonly CompletenessFactGroup[]) {
  const findings = groups.flatMap((group) => group.sample.map((item) => classifyCompletenessFact({
    code: group.code,
    ...item,
  })));
  let impossibleCount = 0;
  let replayable = 0;
  let continuityOnly = 0;
  const oldestRecoverableTimes: number[] = [];

  for (const group of groups) {
    const classification = classifyCompletenessFact({ code: group.code, identity: "classification-probe" });
    if (classification.recovery === "REPLAYABLE") replayable += group.totalCount;
    else if (classification.recovery === "CONTINUITY_ONLY") continuityOnly += group.totalCount;
    else impossibleCount += group.totalCount;
    if (classification.recovery === "REPLAYABLE" && group.oldestRecoverableAt) {
      const timestamp = new Date(group.oldestRecoverableAt).getTime();
      if (Number.isFinite(timestamp)) oldestRecoverableTimes.push(timestamp);
    }
  }

  const totalCount = groups.reduce((sum, group) => sum + group.totalCount, 0);
  const sampleCount = findings.length;
  return {
    findings,
    totalCount,
    sampleCount,
    truncated: sampleCount < totalCount,
    impossibleCount,
    recoverableCount: replayable + continuityOnly,
    replayable,
    continuityOnly,
    oldestRecoverableAt: oldestRecoverableTimes.length
      ? new Date(Math.min(...oldestRecoverableTimes)).toISOString()
      : null,
    ok: impossibleCount === 0,
    fullyRecoverable: impossibleCount === 0 && continuityOnly === 0,
    clean: totalCount === 0,
  };
}
