export type ObservationActivationClass = "OBSERVED_EXISTING" | "NEW_AFTER_ACTIVATION" | "ACTIVATION_UNKNOWN";

export function classifyObservationActivation(
  firstSeenAt: Date,
  initialSyncCompletedAt: readonly (Date | null | undefined)[],
): ObservationActivationClass {
  const boundaries = initialSyncCompletedAt.filter((value): value is Date => value instanceof Date);
  if (boundaries.length === 0) return "ACTIVATION_UNKNOWN";
  return boundaries.some((boundary) => firstSeenAt <= boundary)
    ? "OBSERVED_EXISTING"
    : "NEW_AFTER_ACTIVATION";
}
