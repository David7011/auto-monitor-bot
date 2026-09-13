import { AsyncLocalStorage } from "node:async_hooks";

const currentLease = new AsyncLocalStorage<CollectorLease>();
export class CollectorLeaseLostError extends Error {
  constructor() { super("Collector lease ownership lost"); this.name = "CollectorLeaseLostError"; }
}

export class CollectorLease {
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private renewing = false;
  private expiresAt: number;
  private stopped = false;

  constructor(private readonly options: {
    ttlMs: number;
    renew: () => Promise<boolean>;
    owns: () => Promise<boolean>;
    renewalIntervalMs?: number;
  }) {
    this.expiresAt = Date.now() + options.ttlMs;
    this.timer = setInterval(() => { void this.renew(); }, options.renewalIntervalMs ?? Math.max(5000, Math.floor(options.ttlMs / 3)));
    this.timer.unref();
  }

  get signal(): AbortSignal { return this.controller.signal; }
  run<T>(operation: () => Promise<T>): Promise<T> { return currentLease.run(this, operation); }
  stop(): void { this.stopped = true; clearInterval(this.timer); }

  async assertOwnership(): Promise<void> {
    this.check();
    try { if (!await this.options.owns()) this.lose(); }
    catch { this.lose(); }
    this.check();
  }

  private check(): void {
    if (this.stopped || Date.now() >= this.expiresAt) this.lose();
    this.signal.throwIfAborted();
  }

  private lose(): void { this.controller.abort(new CollectorLeaseLostError()); }

  private async renew(): Promise<void> {
    if (this.renewing || this.stopped || this.signal.aborted) return;
    this.renewing = true;
    try {
      this.check();
      const renewed = await this.options.renew();
      // A late ACK may not resurrect an expired or previously lost owner.
      this.check();
      if (!renewed) this.lose();
      else this.expiresAt = Date.now() + this.options.ttlMs;
    } catch { this.lose(); }
    finally { this.renewing = false; }
  }
}

export function activeCollectorLease(): CollectorLease | undefined { return currentLease.getStore(); }
