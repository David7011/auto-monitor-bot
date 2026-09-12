export interface OlxProtectionSourceState {
  status: string;
  pausedUntil: Date | null;
}

export function deriveOlxProtectionState(
  source: OlxProtectionSourceState | null | undefined,
  now: Date,
): { protected: boolean; reason: string | null } {
  if (!source) return { protected: false, reason: null };

  if (source.pausedUntil != null && source.pausedUntil.getTime() > now.getTime()) {
    return {
      protected: true,
      reason: `OLX protection pause is active until ${source.pausedUntil.toISOString()}; no extra traffic is authorized`,
    };
  }

  if (source.status === "RATE_LIMITED" || source.status === "CAPTCHA_DETECTED") {
    return {
      protected: true,
      reason: `OLX source is ${source.status}; no extra traffic is authorized`,
    };
  }

  return { protected: false, reason: null };
}

export function deriveOlxHotPathStates(input: {
  protected: boolean;
  sourceStatus: string | null;
  parserDegraded: boolean;
  p95Ready: boolean;
  p95Exceeded: boolean;
}): {
  operationalState: "HEALTHY" | "DEGRADED" | "PROTECTED";
  optimizationReadiness: "READY" | "NOT_READY" | "INSUFFICIENT_DATA" | "BLOCKED";
  compatibilityState: "HEALTHY" | "DEGRADED" | "PROTECTED" | "INSUFFICIENT_DATA";
} {
  const operationalState = input.protected
    ? "PROTECTED" as const
    : input.parserDegraded || !input.sourceStatus || !["ACTIVE", "LIMITED"].includes(input.sourceStatus)
      ? "DEGRADED" as const
      : "HEALTHY" as const;
  const optimizationReadiness = input.protected
    ? "BLOCKED" as const
    : !input.p95Ready
      ? "INSUFFICIENT_DATA" as const
      : input.p95Exceeded
        ? "NOT_READY" as const
        : "READY" as const;
  const compatibilityState = input.protected
    ? "PROTECTED" as const
    : !input.p95Ready
      ? "INSUFFICIENT_DATA" as const
      : operationalState === "DEGRADED" || input.p95Exceeded
        ? "DEGRADED" as const
        : "HEALTHY" as const;
  return { operationalState, optimizationReadiness, compatibilityState };
}
