export class TelegramApiTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`Telegram API ${method} exceeded the ${timeoutMs} ms client timeout`);
    this.name = "TelegramApiTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export type TelegramPollingFailurePolicy = {
  severity: "WARN" | "ERROR";
  retryDelayMs: number;
  timedOut: boolean;
};

export function telegramPollingFailurePolicy(
  error: unknown,
  consecutiveFailures: number,
  retryBaseDelayMs: number,
  retryMaxDelayMs: number,
): TelegramPollingFailurePolicy {
  if (error instanceof TelegramApiTimeoutError) {
    return {
      severity: "WARN",
      retryDelayMs: Math.min(1000, retryBaseDelayMs),
      timedOut: true,
    };
  }

  const exponent = Math.max(0, Math.min(5, consecutiveFailures - 1));
  return {
    severity: "ERROR",
    retryDelayMs: Math.min(retryMaxDelayMs, retryBaseDelayMs * 2 ** exponent),
    timedOut: false,
  };
}
