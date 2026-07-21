export function boundedIntegerQuery(
  value: string | undefined,
  options: { fallback: number; min?: number; max: number },
): number | undefined {
  if (value == null || value.trim() === "") return options.fallback;
  if (!/^-?\d+$/u.test(value.trim())) return undefined;
  const parsed = Number(value);
  const min = options.min ?? 1;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > options.max) return undefined;
  return parsed;
}

export function cursorQuery(value: string | undefined, maxLength = 200): string | null | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || !/^[A-Za-z0-9_-]+$/u.test(trimmed)) return null;
  return trimmed;
}
