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
