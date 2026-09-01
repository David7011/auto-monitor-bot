import type { SourceStatus } from "@amb/db";

export type SourceProtectionHealth = {
  status: "OK" | "WARN" | "FAIL";
  message: string;
};

export function sourceProtectionHealth(input: {
  olx: { enabled: boolean; status: SourceStatus; paused: boolean; pausedUntil?: Date | null } | null;
  secondaryCaptcha: number;
  secondaryRateLimited: number;
  secondaryPaused: number;
}): SourceProtectionHealth {
  const olxCritical = !input.olx
    || !input.olx.enabled
    || input.olx.paused
    || ["CAPTCHA_DETECTED", "RATE_LIMITED", "PAUSED", "DISABLED"].includes(input.olx.status);
  const secondaryAffected = input.secondaryCaptcha + input.secondaryRateLimited + input.secondaryPaused;
  const status: SourceProtectionHealth["status"] = olxCritical
    ? "FAIL"
    : input.olx?.status !== "ACTIVE" || secondaryAffected > 0
      ? "WARN"
      : "OK";
  const olxStatus = input.olx
    ? `${input.olx.status}${input.olx.paused ? ", пауза активна" : ""}`
    : "NOT_CONFIGURED";
  const nextProbe = input.olx?.pausedUntil && input.olx.paused
    ? `; штатный probe не ранее ${input.olx.pausedUntil.toISOString()}`
    : "";

  return {
    status,
    message: `OLX: ${olxStatus}${nextProbe}; вторичные источники — CAPTCHA: ${input.secondaryCaptcha}, ограничений частоты: ${input.secondaryRateLimited}, на паузе: ${input.secondaryPaused}`,
  };
}
