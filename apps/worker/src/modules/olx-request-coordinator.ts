import { env } from "../env.js";

export type OlxRequestClass = "REALTIME" | "COVERAGE" | "BACKFILL" | "RECOVERY" | "ENRICHMENT";
type OlxProtectionClassification = "RATE_LIMITED" | "CHALLENGE" | "ACCESS_DENIED";

type RequestCounters = Record<OlxRequestClass, number>;

export type OlxRequestCoordinatorSnapshot = {
  started: RequestCounters;
  completed: RequestCounters;
  totalWaitMs: RequestCounters;
  rateLimited: number;
  challenges: number;
  accessDenied: number;
  activeRealtime: number;
  activeBackground: number;
  queuedBackground: number;
  activeBackgroundClass: Exclude<OlxRequestClass, "REALTIME"> | null;
  realtimePreemptions: number;
  lastWaitMs: RequestCounters;
  maxWaitMs: RequestCounters;
  realtimeQuietCanary: OlxRealtimeQuietCanarySnapshot;
};

export type OlxRealtimeQuietCanaryMode =
  | "DISABLED"
  | "QUALIFYING"
  | "CANARY"
  | "PROMOTED"
  | "ROLLED_BACK";

export type OlxRealtimeQuietCanarySnapshot = {
  mode: OlxRealtimeQuietCanaryMode;
  baselineQuietMs: number;
  candidateQuietMs: number;
  qualifyingSamples: number;
  canarySamples: number;
  baselineP95Ms: number | null;
  canaryP95Ms: number | null;
  rollbackReason: string | null;
};

export type OlxRequestTiming = {
  queuedAt: Date;
  coordinatorStartedAt: Date;
  coordinatorWaitMs: number;
  postFinishQuietMs: number;
};

type QueueEntry<T> = {
  requestClass: OlxRequestClass;
  enqueuedAt: number;
  operation: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  onStarted?: (timing: OlxRequestTiming) => void;
  activeController?: AbortController;
  coordinatorWaitMs?: number;
  appliedPostFinishQuietMs?: number;
  operationStartedAt?: number;
};

type RealtimeQuietCanaryOptions = {
  enabled: boolean;
  candidateQuietMs: number;
  qualificationRequests: number;
  evaluationRequests: number;
  p95GrowthPercent: number;
  queueDepthLimit: number;
};

type CoordinatorOptions = {
  maxBackgroundConcurrency: number;
  backgroundMinIntervalMs: number;
  backgroundQuietAfterRealtimeMs: number;
  postFinishQuietMs?: number;
  rateLimitPauseMs?: number;
  challengePauseMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  beforeRequest?: () => Promise<void>;
  realtimeQuietCanary?: Partial<RealtimeQuietCanaryOptions>;
};

const REQUEST_CLASSES: OlxRequestClass[] = ["REALTIME", "COVERAGE", "BACKFILL", "RECOVERY", "ENRICHMENT"];
const REQUEST_PRIORITY: Record<OlxRequestClass, number> = {
  REALTIME: 0,
  RECOVERY: 1,
  COVERAGE: 2,
  BACKFILL: 3,
  ENRICHMENT: 4,
};
export const OLX_REQUEST_POST_FINISH_QUIET_MS = 350;

/**
 * Serializes every OLX origin request through one priority queue. Realtime is
 * always selected first, while background work is paced between hot requests.
 * A protection response opens the circuit before the active slot is released,
 * so already queued work cannot race another HTTP request into the same limit.
 */
export class OlxRequestCoordinator {
  private readonly maxInFlight: number;
  private readonly backgroundMinIntervalMs: number;
  private readonly backgroundQuietAfterRealtimeMs: number;
  private readonly postFinishQuietMs: number;
  private readonly rateLimitPauseMs: number;
  private readonly challengePauseMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private beforeRequest: () => Promise<void>;
  private readonly started = emptyCounters();
  private readonly completed = emptyCounters();
  private readonly totalWaitMs = emptyCounters();
  private readonly lastWaitMs = emptyCounters();
  private readonly maxWaitMs = emptyCounters();
  private readonly queue: Array<QueueEntry<unknown>> = [];
  private activeRealtime = 0;
  private activeBackground = 0;
  private activeBackgroundEntry: QueueEntry<unknown> | null = null;
  private lastRealtimeFinishedAt = Number.NEGATIVE_INFINITY;
  private lastRequestFinishedAt = Number.NEGATIVE_INFINITY;
  private lastBackgroundStartedAt = Number.NEGATIVE_INFINITY;
  private draining = false;
  private circuitOpenUntil = Number.NEGATIVE_INFINITY;
  private circuitClassification: OlxProtectionClassification = "RATE_LIMITED";
  private rateLimited = 0;
  private challenges = 0;
  private accessDenied = 0;
  private realtimePreemptions = 0;
  private lastCompletedRequestClass: OlxRequestClass | null = null;
  private readonly realtimeQuietCanary: RealtimeQuietCanary;

  constructor(options: CoordinatorOptions) {
    // Keep accepting the legacy option, but hard-cap the origin to one request.
    this.maxInFlight = Math.min(1, Math.max(1, Math.trunc(options.maxBackgroundConcurrency)));
    this.backgroundMinIntervalMs = Math.max(0, Math.trunc(options.backgroundMinIntervalMs));
    this.backgroundQuietAfterRealtimeMs = Math.max(0, Math.trunc(options.backgroundQuietAfterRealtimeMs));
    this.postFinishQuietMs = Math.max(0, Math.trunc(
      options.postFinishQuietMs ?? OLX_REQUEST_POST_FINISH_QUIET_MS,
    ));
    this.rateLimitPauseMs = Math.max(1_000, Math.trunc(options.rateLimitPauseMs ?? 90_000));
    this.challengePauseMs = Math.max(1_000, Math.trunc(options.challengePauseMs ?? 15 * 60_000));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.beforeRequest = options.beforeRequest ?? (() => Promise.resolve());
    this.realtimeQuietCanary = new RealtimeQuietCanary(
      this.postFinishQuietMs,
      options.realtimeQuietCanary,
    );
  }

  async run<T>(
    requestClass: OlxRequestClass,
    operation: (signal: AbortSignal) => Promise<T>,
    onStarted?: (timing: OlxRequestTiming) => void,
  ): Promise<T> {
    if (this.circuitOpenUntil > this.now()) throw this.circuitError();
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        requestClass,
        enqueuedAt: this.now(),
        operation,
        resolve,
        reject,
        onStarted,
      } as QueueEntry<unknown>);
      this.sortQueue();
      if (requestClass === "REALTIME") {
        this.realtimeQuietCanary.observeQueueDepth(
          this.queue.filter((entry) => entry.requestClass === "REALTIME").length,
        );
      }
      if (requestClass === "REALTIME") this.preemptActiveBackground();
      void this.drain();
    });
  }

  snapshot(): OlxRequestCoordinatorSnapshot {
    return {
      started: { ...this.started },
      completed: { ...this.completed },
      totalWaitMs: { ...this.totalWaitMs },
      rateLimited: this.rateLimited,
      challenges: this.challenges,
      accessDenied: this.accessDenied,
      activeRealtime: this.activeRealtime,
      activeBackground: this.activeBackground,
      queuedBackground: this.queue.filter((entry) => entry.requestClass !== "REALTIME").length,
      activeBackgroundClass: this.activeBackgroundEntry?.requestClass as Exclude<OlxRequestClass, "REALTIME"> | undefined ?? null,
      realtimePreemptions: this.realtimePreemptions,
      lastWaitMs: { ...this.lastWaitMs },
      maxWaitMs: { ...this.maxWaitMs },
      realtimeQuietCanary: this.realtimeQuietCanary.snapshot(),
    };
  }

  setBeforeRequest(guard: () => Promise<void>): void {
    this.beforeRequest = guard;
  }

  private async execute<T>(entry: QueueEntry<T>): Promise<void> {
    const controller = new AbortController();
    entry.activeController = controller;
    if (entry.requestClass !== "REALTIME") {
      this.activeBackgroundEntry = entry as QueueEntry<unknown>;
    }
    let preempted = false;
    try {
      // Fence every origin request, not merely every BullMQ job. A stale
      // process that resumes after losing the leader lease must fail before it
      // can bypass the newly promoted replica's global OLX pacing.
      await this.beforeRequest();
      entry.operationStartedAt = this.now();
      entry.onStarted?.({
        queuedAt: new Date(entry.enqueuedAt),
        coordinatorStartedAt: new Date(entry.operationStartedAt),
        coordinatorWaitMs: entry.coordinatorWaitMs ?? 0,
        postFinishQuietMs: entry.appliedPostFinishQuietMs ?? this.postFinishQuietMs,
      });
      const result = await entry.operation(controller.signal);
      // Observe protection before resolve/finally can release the slot and
      // trigger drain. This ordering is the circuit-breaker correctness edge.
      const protectionObserved = this.observeOutcome(result, entry as QueueEntry<unknown>);
      // A protection response that won the abort race must never be discarded:
      // it opens the circuit and prevents realtime from firing into a 403/429
      // or challenge. Ordinary successful background responses are replayed.
      if (!protectionObserved) controller.signal.throwIfAborted();
      entry.resolve(result);
    } catch (error) {
      if (entry.requestClass !== "REALTIME" && error instanceof OlxRequestPreemptedError) {
        preempted = true;
        this.realtimePreemptions += 1;
        this.queue.push(entry as QueueEntry<unknown>);
        this.sortQueue();
      } else {
        this.observeCanaryFailure(entry as QueueEntry<unknown>, error);
        entry.reject(error);
      }
    } finally {
      if (entry.requestClass === "REALTIME") {
        this.activeRealtime = Math.max(0, this.activeRealtime - 1);
        this.lastRealtimeFinishedAt = this.now();
      } else {
        this.activeBackground = Math.max(0, this.activeBackground - 1);
        if (this.activeBackgroundEntry === entry) this.activeBackgroundEntry = null;
      }
      entry.activeController = undefined;
      if (!preempted) {
        this.completed[entry.requestClass] += 1;
        this.lastRequestFinishedAt = this.now();
        this.lastCompletedRequestClass = entry.requestClass;
      }
      void this.drain();
    }
  }

  private preemptActiveBackground(): void {
    const entry = this.activeBackgroundEntry;
    const controller = entry?.activeController;
    if (!entry || !controller || controller.signal.aborted) return;
    controller.abort(new OlxRequestPreemptedError(
      entry.requestClass as Exclude<OlxRequestClass, "REALTIME">,
    ));
  }

  private sortQueue(): void {
    this.queue.sort((left, right) =>
      REQUEST_PRIORITY[left.requestClass] - REQUEST_PRIORITY[right.requestClass]
      || left.enqueuedAt - right.enqueuedAt);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (
        this.queue.length > 0
        && this.activeRealtime + this.activeBackground < this.maxInFlight
      ) {
        if (this.circuitOpenUntil > this.now()) {
          this.rejectQueuedForOpenCircuit();
          break;
        }

        const entry = this.queue[0];
        if (!entry) break;
        const now = this.now();
        const background = entry.requestClass !== "REALTIME";
        const postFinishQuietMs = this.realtimeQuietCanary.quietMsFor(
          entry.requestClass,
          this.lastCompletedRequestClass,
        );
        const waitForPostFinish = Math.max(
          0,
          this.lastRequestFinishedAt + postFinishQuietMs - now,
        );
        const waitForRealtimeQuiet = background
          ? Math.max(0, this.lastRealtimeFinishedAt + this.backgroundQuietAfterRealtimeMs - now)
          : 0;
        const waitForBackgroundPacing = background
          ? Math.max(0, this.lastBackgroundStartedAt + this.backgroundMinIntervalMs - now)
          : 0;
        const waitMs = Math.max(waitForPostFinish, waitForRealtimeQuiet, waitForBackgroundPacing);
        if (waitMs > 0) {
          await this.sleep(Math.min(waitMs, 100));
          continue;
        }

        this.queue.shift();
        if (entry.requestClass === "REALTIME") this.activeRealtime += 1;
        else this.activeBackground += 1;
        this.started[entry.requestClass] += 1;
        const coordinatorWaitMs = Math.max(0, this.now() - entry.enqueuedAt);
        entry.coordinatorWaitMs = coordinatorWaitMs;
        entry.appliedPostFinishQuietMs = postFinishQuietMs;
        this.totalWaitMs[entry.requestClass] += coordinatorWaitMs;
        this.lastWaitMs[entry.requestClass] = coordinatorWaitMs;
        this.maxWaitMs[entry.requestClass] = Math.max(
          this.maxWaitMs[entry.requestClass],
          coordinatorWaitMs,
        );
        if (entry.requestClass !== "REALTIME") this.lastBackgroundStartedAt = this.now();
        void this.execute(entry);
      }
    } finally {
      this.draining = false;
      if (
        this.queue.length > 0
        && this.activeRealtime + this.activeBackground < this.maxInFlight
      ) {
        void this.drain();
      }
    }
  }

  private observeOutcome(value: unknown, entry: QueueEntry<unknown>): boolean {
    if (!value || typeof value !== "object") return false;
    const outcome = value as { classification?: unknown; retryAfterSeconds?: unknown };
    if (outcome.classification === "RATE_LIMITED") this.rateLimited += 1;
    if (outcome.classification === "CHALLENGE") this.challenges += 1;
    if (outcome.classification === "ACCESS_DENIED") this.accessDenied += 1;
    const protectionClassification = outcome.classification === "RATE_LIMITED"
      || outcome.classification === "CHALLENGE"
      || outcome.classification === "ACCESS_DENIED"
      ? outcome.classification
      : null;
    const protectionObserved = protectionClassification !== null;
    this.realtimeQuietCanary.observeResult({
      requestClass: entry.requestClass,
      classification: typeof outcome.classification === "string" ? outcome.classification : undefined,
      elapsedMs: this.requestElapsedMs(entry),
      usedCandidateQuiet: entry.appliedPostFinishQuietMs === this.realtimeQuietCanary.candidateQuietMs,
      protectionObserved,
    });
    if (!protectionObserved) return false;

    const retryAfterMs = typeof outcome.retryAfterSeconds === "number"
      && Number.isFinite(outcome.retryAfterSeconds)
      && outcome.retryAfterSeconds > 0
      ? Math.ceil(outcome.retryAfterSeconds * 1_000)
      : 0;
    const localPauseMs = protectionClassification === "CHALLENGE"
      ? this.challengePauseMs
      : this.rateLimitPauseMs;
    this.circuitOpenUntil = Math.max(
      this.circuitOpenUntil,
      this.now() + Math.max(localPauseMs, retryAfterMs),
    );
    this.circuitClassification = protectionClassification;
    return true;
  }

  private observeCanaryFailure(entry: QueueEntry<unknown>, error: unknown): void {
    if (entry.requestClass !== "REALTIME") return;
    this.realtimeQuietCanary.observeFailure(
      error instanceof Error ? error.name : "UNKNOWN_ERROR",
    );
  }

  private requestElapsedMs(entry: QueueEntry<unknown>): number {
    return Math.max(
      0,
      (entry.coordinatorWaitMs ?? 0)
        + (entry.operationStartedAt === undefined ? 0 : this.now() - entry.operationStartedAt),
    );
  }

  private rejectQueuedForOpenCircuit(): void {
    while (this.queue.length > 0) {
      this.queue.shift()?.reject(this.circuitError());
    }
  }

  private circuitError(): OlxCircuitOpenError {
    return new OlxCircuitOpenError(
      this.circuitClassification,
      Math.max(1, Math.ceil((this.circuitOpenUntil - this.now()) / 1_000)),
    );
  }
}

export function setOlxRequestLeadershipGuard(guard: () => Promise<void>): void {
  olxRequestCoordinator.setBeforeRequest(guard);
}

export class OlxCircuitOpenError extends Error {
  constructor(
    readonly classification: OlxProtectionClassification,
    readonly retryAfterSeconds: number,
  ) {
    super(`OLX request circuit is open for ${retryAfterSeconds}s`);
    this.name = "OlxCircuitOpenError";
  }
}

export class OlxRequestPreemptedError extends Error {
  constructor(readonly interruptedClass: Exclude<OlxRequestClass, "REALTIME">) {
    super(`OLX ${interruptedClass} request was preempted by realtime`);
    this.name = "OlxRequestPreemptedError";
  }
}

function emptyCounters(): RequestCounters {
  return Object.fromEntries(REQUEST_CLASSES.map((requestClass) => [requestClass, 0])) as RequestCounters;
}

class RealtimeQuietCanary {
  readonly candidateQuietMs: number;
  private readonly qualificationRequests: number;
  private readonly evaluationRequests: number;
  private readonly p95GrowthRatio: number;
  private readonly queueDepthLimit: number;
  private mode: OlxRealtimeQuietCanaryMode;
  private readonly baselineSamples: number[] = [];
  private readonly canarySamples: number[] = [];
  private rollbackReason: string | null = null;

  constructor(
    private readonly baselineQuietMs: number,
    options: Partial<RealtimeQuietCanaryOptions> | undefined,
  ) {
    const enabled = options?.enabled ?? false;
    this.candidateQuietMs = Math.max(
      0,
      Math.min(baselineQuietMs, Math.trunc(options?.candidateQuietMs ?? 150)),
    );
    this.qualificationRequests = Math.max(1, Math.trunc(options?.qualificationRequests ?? 100));
    this.evaluationRequests = Math.max(1, Math.trunc(options?.evaluationRequests ?? 30));
    this.p95GrowthRatio = Math.max(1, (options?.p95GrowthPercent ?? 120) / 100);
    this.queueDepthLimit = Math.max(1, Math.trunc(options?.queueDepthLimit ?? 25));
    this.mode = enabled && this.candidateQuietMs < baselineQuietMs ? "QUALIFYING" : "DISABLED";
  }

  quietMsFor(requestClass: OlxRequestClass, previousClass: OlxRequestClass | null): number {
    if (
      requestClass === "REALTIME"
      && previousClass === "REALTIME"
      && (this.mode === "CANARY" || this.mode === "PROMOTED")
    ) return this.candidateQuietMs;
    return this.baselineQuietMs;
  }

  observeQueueDepth(depth: number): void {
    if (depth <= this.queueDepthLimit) return;
    if (this.mode === "CANARY" || this.mode === "PROMOTED") {
      this.rollback(`REALTIME_QUEUE_DEPTH_${depth}`);
    } else if (this.mode === "QUALIFYING") {
      this.baselineSamples.length = 0;
    }
  }

  observeResult(input: {
    requestClass: OlxRequestClass;
    classification?: string;
    elapsedMs: number;
    usedCandidateQuiet: boolean;
    protectionObserved: boolean;
  }): void {
    if (input.requestClass !== "REALTIME" || this.mode === "DISABLED" || this.mode === "ROLLED_BACK") return;
    if (input.protectionObserved) {
      this.rollback(`PROTECTION_${input.classification ?? "UNKNOWN"}`);
      return;
    }
    const clean = input.classification === "SUCCESS"
      || input.classification === "EMPTY_RESULT"
      || input.classification === "NOT_MODIFIED";
    if (!clean) {
      if (this.mode === "QUALIFYING") this.baselineSamples.length = 0;
      else this.rollback(`NON_CLEAN_${input.classification ?? "UNKNOWN"}`);
      return;
    }

    if (this.mode === "QUALIFYING") {
      this.baselineSamples.push(input.elapsedMs);
      trimToLast(this.baselineSamples, this.qualificationRequests);
      if (this.baselineSamples.length >= this.qualificationRequests) this.mode = "CANARY";
      return;
    }

    if (!input.usedCandidateQuiet) return;
    this.canarySamples.push(input.elapsedMs);
    trimToLast(this.canarySamples, this.evaluationRequests);
    const baselineP95 = percentile95(this.baselineSamples);
    const canaryP95 = percentile95(this.canarySamples);
    if (baselineP95 !== null && canaryP95 !== null && canaryP95 > baselineP95 * this.p95GrowthRatio) {
      this.rollback(`P95_GROWTH_${Math.round(canaryP95)}_VS_${Math.round(baselineP95)}`);
      return;
    }
    if (this.canarySamples.length >= this.evaluationRequests) this.mode = "PROMOTED";
  }

  observeFailure(reason: string): void {
    if (this.mode === "QUALIFYING") this.baselineSamples.length = 0;
    else if (this.mode === "CANARY" || this.mode === "PROMOTED") this.rollback(`ERROR_${reason}`);
  }

  snapshot(): OlxRealtimeQuietCanarySnapshot {
    return {
      mode: this.mode,
      baselineQuietMs: this.baselineQuietMs,
      candidateQuietMs: this.candidateQuietMs,
      qualifyingSamples: this.baselineSamples.length,
      canarySamples: this.canarySamples.length,
      baselineP95Ms: percentile95(this.baselineSamples),
      canaryP95Ms: percentile95(this.canarySamples),
      rollbackReason: this.rollbackReason,
    };
  }

  private rollback(reason: string): void {
    this.mode = "ROLLED_BACK";
    this.rollbackReason = reason;
  }
}

function trimToLast(values: number[], limit: number): void {
  if (values.length > limit) values.splice(0, values.length - limit);
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
}

export const olxRequestCoordinator = new OlxRequestCoordinator({
  maxBackgroundConcurrency: 1,
  backgroundMinIntervalMs: env.OLX_BACKGROUND_REQUEST_MIN_INTERVAL_MS,
  backgroundQuietAfterRealtimeMs: env.OLX_BACKGROUND_AFTER_REALTIME_QUIET_MS,
  postFinishQuietMs: OLX_REQUEST_POST_FINISH_QUIET_MS,
  realtimeQuietCanary: {
    enabled: env.OLX_REALTIME_QUIET_CANARY_ENABLED,
    candidateQuietMs: env.OLX_REALTIME_QUIET_CANARY_CANDIDATE_MS,
    qualificationRequests: env.OLX_REALTIME_QUIET_CANARY_QUALIFICATION_REQUESTS,
    evaluationRequests: env.OLX_REALTIME_QUIET_CANARY_EVALUATION_REQUESTS,
    p95GrowthPercent: env.OLX_REALTIME_QUIET_CANARY_P95_GROWTH_PERCENT,
    queueDepthLimit: env.OLX_REALTIME_QUIET_CANARY_QUEUE_DEPTH_LIMIT,
  },
  rateLimitPauseMs: env.RATE_LIMIT_PAUSE_BASE_SECONDS * 1_000,
  challengePauseMs: env.CAPTCHA_PAUSE_SECONDS * 1_000,
});
