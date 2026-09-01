export type OlxCoverageState = {
  lastRegionalCoverageAt?: Date;
  lastHtmlCoverageAt?: Date;
  htmlCoveragePausedUntil?: Date;
  lastPrivateCoverageAt?: Date;
};

export type OlxCoverageSchedule = {
  regionalDue: boolean;
  htmlDue: boolean;
  privateDue: boolean;
};

export function olxCoverageExecutionSchedule(input: {
  coverageOnly: boolean;
  suppressBackground: boolean;
  now: Date;
  state: OlxCoverageState;
  hasRegionalFilters: boolean;
  regionalIntervalSeconds: number;
  htmlIntervalSeconds: number;
  privateIntervalSeconds: number;
}): OlxCoverageSchedule {
  if (!input.coverageOnly || input.suppressBackground) {
    return { regionalDue: false, htmlDue: false, privateDue: false };
  }
  return olxCoverageSchedule({ ...input, isBackfill: false });
}

export function olxCoverageSchedule(input: {
  now: Date;
  state: OlxCoverageState;
  isBackfill: boolean;
  hasRegionalFilters: boolean;
  regionalIntervalSeconds: number;
  htmlIntervalSeconds: number;
  privateIntervalSeconds: number;
}): OlxCoverageSchedule {
  if (input.isBackfill) return { regionalDue: false, htmlDue: false, privateDue: false };

  const nowMs = input.now.getTime();
  return {
    regionalDue: input.hasRegionalFilters && elapsed(nowMs, input.state.lastRegionalCoverageAt) >= seconds(input.regionalIntervalSeconds, 15),
    htmlDue: (!input.state.htmlCoveragePausedUntil || input.state.htmlCoveragePausedUntil.getTime() <= nowMs) &&
      elapsed(nowMs, input.state.lastHtmlCoverageAt) >= seconds(input.htmlIntervalSeconds, 30),
    privateDue: elapsed(nowMs, input.state.lastPrivateCoverageAt) >= seconds(input.privateIntervalSeconds, 30),
  };
}

function elapsed(nowMs: number, lastAt: Date | undefined): number {
  return lastAt ? Math.max(0, nowMs - lastAt.getTime()) : Number.POSITIVE_INFINITY;
}

function seconds(value: number, minimum: number): number {
  return Math.max(minimum, Number.isFinite(value) ? value : minimum) * 1_000;
}
