export type FakeFault =
  | "EMPTY"
  | "PARTIAL"
  | "PARSER_DEGRADED"
  | "TIMEOUT"
  | "CONNECTION_RESET"
  | "HTTP_403"
  | "HTTP_429"
  | "CAPTCHA"
  | "HTTP_500";

export type FakeAdvert = {
  id: string;
  publishedAt: Date | null;
  sequence: number;
};

export type FakePage = {
  candidates: FakeAdvert[];
  parserHealth: "HEALTHY" | "DEGRADED";
  protection: "NONE" | "ACCESS_DENIED" | "RATE_LIMITED" | "CAPTCHA" | "SERVER_ERROR";
  partial: boolean;
  capped: boolean;
};

export class FakeTransportError extends Error {
  constructor(readonly kind: "TIMEOUT" | "CONNECTION_RESET") {
    super(kind);
  }
}

export class DeterministicMarketplace {
  private readonly adverts: FakeAdvert[] = [];
  private readonly faults: FakeFault[] = [];
  private sequence = 0;

  constructor(readonly publicOffsetCap = Number.POSITIVE_INFINITY) {}

  publish(count: number, options: { timestamp?: Date | null; prefix?: string } = {}): FakeAdvert[] {
    const timestamp = options.timestamp === undefined ? new Date("2026-09-12T08:00:00.000Z") : options.timestamp;
    const published = Array.from({ length: count }, () => {
      this.sequence += 1;
      return {
        id: `${options.prefix ?? "fake"}-${String(this.sequence).padStart(4, "0")}`,
        publishedAt: timestamp && new Date(timestamp.getTime() + this.sequence),
        sequence: this.sequence,
      };
    });
    this.adverts.unshift(...published.reverse());
    return published;
  }

  enqueueFault(...faults: FakeFault[]): void {
    this.faults.push(...faults);
  }

  fetchPage(page: number, pageSize: number): FakePage {
    const offset = Math.max(0, page - 1) * pageSize;
    if (offset >= this.publicOffsetCap) {
      return { candidates: [], parserHealth: "HEALTHY", protection: "NONE", partial: false, capped: true };
    }
    const fault = this.faults.shift();
    if (fault === "TIMEOUT" || fault === "CONNECTION_RESET") throw new FakeTransportError(fault);
    if (fault === "EMPTY") return pageResult([]);
    if (fault === "PARSER_DEGRADED") return { ...pageResult([]), parserHealth: "DEGRADED" };
    if (fault === "HTTP_403") return { ...pageResult([]), protection: "ACCESS_DENIED" };
    if (fault === "HTTP_429") return { ...pageResult([]), protection: "RATE_LIMITED" };
    if (fault === "CAPTCHA") return { ...pageResult([]), protection: "CAPTCHA" };
    if (fault === "HTTP_500") return { ...pageResult([]), protection: "SERVER_ERROR" };
    const candidates = this.adverts.slice(offset, Math.min(offset + pageSize, this.publicOffsetCap));
    if (fault === "PARTIAL") return { ...pageResult(candidates.slice(0, Math.max(1, Math.floor(candidates.length / 2)))), partial: true };
    return pageResult(candidates);
  }

  ids(): string[] {
    return this.adverts.map((advert) => advert.id);
  }
}

function pageResult(candidates: FakeAdvert[]): FakePage {
  return { candidates, parserHealth: "HEALTHY", protection: "NONE", partial: false, capped: false };
}

export class DurableFakeLedger {
  readonly observations = new Map<string, "PENDING" | "REJECTED" | "DUPLICATE" | "SHADOWED" | "NOTIFIED" | "FAILED_REPLAYABLE">();

  persistBatch(candidates: readonly FakeAdvert[]): void {
    for (const candidate of candidates) {
      if (!this.observations.has(candidate.id)) this.observations.set(candidate.id, "PENDING");
    }
  }

  finish(id: string, outcome: Exclude<DurableFakeLedger["observations"] extends Map<string, infer T> ? T : never, "PENDING">): void {
    if (!this.observations.has(id)) throw new Error(`Cannot finish unjournaled candidate ${id}`);
    this.observations.set(id, outcome);
  }
}

export function assertNoVanishedCandidates(deliveredIds: ReadonlySet<string>, ledger: DurableFakeLedger): void {
  const vanished = [...deliveredIds].filter((id) => !ledger.observations.has(id));
  if (vanished.length > 0) throw new Error(`Vanished normalized IDs: ${vanished.join(", ")}`);
}
