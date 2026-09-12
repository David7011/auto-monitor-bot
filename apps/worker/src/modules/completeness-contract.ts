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
  const recoverable = fact.code === "KNOWN_ID_WITHOUT_OBSERVATION"
    || fact.code === "STALE_REPLAYABLE_OBSERVATION"
    || fact.code === "BOUNDARY_AHEAD_OF_INCOMPLETE_OBSERVATION";
  return { ...fact, severity: recoverable ? "RECOVERABLE" : "IMPOSSIBLE" };
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
