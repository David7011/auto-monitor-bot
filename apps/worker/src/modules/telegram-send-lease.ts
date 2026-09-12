/** Own an existing attempt without holding a DB transaction during gate/HTTP. */
export async function withRenewableTelegramLease<T>(
  renew: () => Promise<boolean>,
  operation: (assertOwned: () => Promise<void>) => Promise<T>,
  renewalIntervalMs = 15_000,
): Promise<T> {
  let failure: Error | undefined;
  let pending: Promise<void> | undefined;
  const check = (): Promise<void> => {
    pending ??= (async () => {
      try {
        if (!await renew()) failure = new Error("Telegram send lease ownership lost or expired");
      } catch (cause) {
        failure = new Error("Telegram send lease renewal failed", { cause });
      }
    })().finally(() => { pending = undefined; });
    return pending;
  };
  const timer = setInterval(() => {
    if (!failure) void check();
  }, renewalIntervalMs);
  timer.unref();
  try {
    return await operation(async () => {
      if (!failure) await check();
      if (failure) throw failure;
    });
  } finally {
    clearInterval(timer);
  }
}
