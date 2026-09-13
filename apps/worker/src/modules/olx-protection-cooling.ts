export type OlxProtectionCoolingState = {
  active: boolean;
  until: Date | null;
  remainingSeconds: number;
};

export function olxProtectionCoolingState(input: {
  detectedAt?: Date | null;
  cooldownUntil?: Date | null;
  status?: string | null;
  recoveredAt?: Date | null;
  coolingSeconds: number;
  now?: Date;
}): OlxProtectionCoolingState {
  if (!input.detectedAt) {
    return { active: false, until: null, remainingSeconds: 0 };
  }

  const now = input.now ?? new Date();
  const configuredCoolingMs = Math.max(
    0,
    Math.trunc(input.coolingSeconds * 1_000),
  );
  const recovered = input.status === "RESOLVED" && input.recoveredAt != null
    && Number.isFinite(input.recoveredAt.getTime()) && input.recoveredAt >= input.detectedAt;
  // A confirmed successful recovery ends the old incident's pause, not the
  // post-recovery quiet window. Missing/inconsistent recovery evidence fails closed.
  const configuredUntilMs = (recovered ? input.recoveredAt!.getTime() : input.detectedAt.getTime()) + configuredCoolingMs;
  const serverCooldownUntilMs = recovered ? 0 : input.cooldownUntil?.getTime() ?? 0;
  const until = new Date(Math.max(configuredUntilMs, serverCooldownUntilMs));
  const remainingMs = Math.max(0, until.getTime() - now.getTime());

  return {
    active: remainingMs > 0,
    until,
    remainingSeconds: Math.ceil(remainingMs / 1_000),
  };
}
