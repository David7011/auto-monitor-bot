export type RuntimeEnvSource = Readonly<Record<string, string | undefined>>;

export type NumberEnvOptions = {
  integer?: boolean;
  min?: number;
  max?: number;
};

/**
 * Strict runtime environment reader shared by every local service.
 * Empty values consistently fall back, while malformed configured values fail
 * the process during startup instead of silently changing runtime behaviour.
 */
export class RuntimeEnvReader {
  constructor(private readonly source: RuntimeEnvSource) {}

  string(key: string, fallback = ""): string {
    const raw = this.source[key];
    return raw == null || raw.trim() === "" ? fallback : raw;
  }

  number(key: string, fallback: number, options: NumberEnvOptions = {}): number {
    const raw = this.source[key];
    const value = raw == null || raw.trim() === "" ? fallback : Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
    if (options.integer && !Number.isInteger(value)) throw new Error(`${key} must be an integer`);
    if (options.min != null && value < options.min) throw new Error(`${key} must be at least ${options.min}`);
    if (options.max != null && value > options.max) throw new Error(`${key} must be at most ${options.max}`);
    return value;
  }

  boolean(key: string, fallback = false): boolean {
    const raw = this.source[key];
    if (raw == null || raw.trim() === "") return fallback;
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
    throw new Error(`${key} must be true/false or 1/0`);
  }

  enum<const T extends string>(key: string, values: readonly T[], fallback: T): T {
    const raw = this.source[key];
    if (raw == null || raw.trim() === "") return fallback;
    if (!values.includes(raw as T)) throw new Error(`${key} must be one of: ${values.join(", ")}`);
    return raw as T;
  }
}

export function createRuntimeEnvReader(source: RuntimeEnvSource = process.env): RuntimeEnvReader {
  return new RuntimeEnvReader(source);
}

export function assertIntegerRange(key: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
}

export function assertNumberRange(key: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be a number between ${min} and ${max}`);
  }
}

export function assertNumberOrder(
  lowerKey: string,
  lowerValue: number,
  upperKey: string,
  upperValue: number,
): void {
  if (upperValue < lowerValue) {
    throw new Error(`${upperKey} must be greater than or equal to ${lowerKey}`);
  }
}
