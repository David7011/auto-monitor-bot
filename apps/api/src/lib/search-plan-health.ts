import type { SourceStatus } from "@amb/db";

const UNAVAILABLE_SOURCE_STATUSES: SourceStatus[] = [
  "RATE_LIMITED",
  "CAPTCHA_DETECTED",
  "ERROR",
  "PAUSED",
  "DISABLED",
];

export function olxHtmlCoverageIssue(input: {
  sourceStatus?: SourceStatus;
  lastHtmlCoverageAt?: Date | null;
  intervalSeconds: number;
  now?: Date;
}): string | null {
  const now = input.now ?? new Date();
  const staleAfterMs = Math.max(30, input.intervalSeconds) * 2_000;
  if (
    input.lastHtmlCoverageAt
    && input.lastHtmlCoverageAt.getTime() >= now.getTime() - staleAfterMs
  ) {
    return null;
  }

  return input.sourceStatus && UNAVAILABLE_SOURCE_STATUSES.includes(input.sourceStatus)
    ? "HTML-сверка OLX не подтверждается, пока источник находится в защитной паузе"
    : "HTML-сверка OLX давно не подтверждалась; доступность realtime-контура требует проверки";
}
