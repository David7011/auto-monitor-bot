export type OlxProtectionCoolingState = {
  active: boolean;
  until: Date | null;
  remainingSeconds: number;
};

export function olxProtectionCoolingState(input: {
  detectedAt?: Date | null;
  cooldownUntil?: Date | null;
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
  const configuredUntilMs = input.detectedAt.getTime() + configuredCoolingMs;
  const serverCooldownUntilMs = input.cooldownUntil?.getTime() ?? 0;
  const until = new Date(Math.max(configuredUntilMs, serverCooldownUntilMs));
  const remainingMs = Math.max(0, until.getTime() - now.getTime());

  return {
    active: remainingMs > 0,
    until,
    remainingSeconds: Math.ceil(remainingMs / 1_000),
  };
}
