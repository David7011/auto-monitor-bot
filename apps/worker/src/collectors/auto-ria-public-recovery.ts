import type { OlxRecoveryUnresolvedReason } from "@amb/shared";

export const AUTO_RIA_PUBLIC_RECOVERY_DEPTH = 50;

export function autoRiaPublicOutage(input: {
  startedAt: Date; lastSuccessfulScanAt?: Date; intervalSeconds: number; jitterSeconds: number;
}): boolean {
  if (!input.lastSuccessfulScanAt) return false;
  // Two cadence slots tolerate one normal slow run; completion time is never evidence of a late start.
  return input.startedAt.getTime() - input.lastSuccessfulScanAt.getTime()
    > (2 * Math.max(1, input.intervalSeconds) + Math.max(0, input.jitterSeconds) + 5) * 1_000;
}
export type AutoRiaPublicRecoveryCursor = {
  version: 1;
  feedIndex: number;
  feeds: Array<{ url: string; nextPage: number; overlapIds: string[]; done: boolean; reason?: string }>;
};

export function publicRecoveryCursor(value: unknown, urls: readonly string[]): AutoRiaPublicRecoveryCursor {
  const previous = value as Partial<AutoRiaPublicRecoveryCursor> | null;
  if (previous?.version === 1 && Array.isArray(previous.feeds)
    && previous.feeds.length === urls.length
    && previous.feeds.every((feed, index) => feed.url === urls[index]
      && Number.isInteger(feed.nextPage) && feed.nextPage >= 0 && feed.nextPage <= AUTO_RIA_PUBLIC_RECOVERY_DEPTH
      && Array.isArray(feed.overlapIds) && feed.overlapIds.every(id => typeof id === "string")
      && typeof feed.done === "boolean")
    && Number.isInteger(previous.feedIndex) && previous.feedIndex! >= 0 && previous.feedIndex! < urls.length) {
    return structuredClone(previous as AutoRiaPublicRecoveryCursor);
  }
  return { version: 1, feedIndex: 0, feeds: urls.map(url => ({ url, nextPage: 0, overlapIds: [], done: false })) };
}

export function publicSearchPageUrl(base: string, page: number): string {
  const url = new URL(base);
  url.searchParams.set("page", String(page));
  return url.toString();
}

/** Public order is unproven: overlap is a bounded stopping hint, never coverage proof. */
export async function collectPublicRecovery(input: {
  urls: string[];
  cursor?: unknown;
  anchors: ReadonlySet<string>;
  maxRequests: number;
  canContinue: () => boolean;
  ingest: (url: string) => Promise<{ ids: string[]; complete: boolean; blocked?: boolean }>;
}): Promise<{ cursor: AutoRiaPublicRecoveryCursor; progressed: number; reason?: OlxRecoveryUnresolvedReason; noProgressReason?: string }> {
  const cursor = publicRecoveryCursor(input.cursor, input.urls);
  let progressed = 0;
  let requests = 0;
  let noProgressReason: string | undefined;
  const validated = new Set<number>();
  while (requests < input.maxRequests && input.canContinue() && cursor.feeds.some(feed => !feed.done)) {
    const index = cursor.feedIndex;
    const feed = cursor.feeds[index]!;
    cursor.feedIndex = (index + 1) % cursor.feeds.length;
    if (feed.done) continue;
    const overlap = feed.nextPage > 0 && !validated.has(index);
    const page = overlap ? feed.nextPage - 1 : feed.nextPage;
    const result = await input.ingest(publicSearchPageUrl(feed.url, page));
    requests += 1;
    if (result.blocked) break;
    if (!result.complete) {
      noProgressReason = "PUBLIC_PAGE_INCOMPLETE";
      break; // Never advance past candidates omitted by the budget or a malformed card.
    }
    if (!result.ids.length) {
      feed.done = true; feed.reason = "EMPTY_PUBLIC_PAGE_UNPROVEN"; progressed += 1;
      continue;
    }
    if (overlap) {
      if (!feed.overlapIds.every(id => result.ids.includes(id))) {
        // Mutable offset moved: restart this feed, retaining delivered IDs in the journal.
        feed.nextPage = 0; feed.overlapIds = [];
        noProgressReason = "PUBLIC_OVERLAP_MOVED";
        break;
      }
      validated.add(index);
      // Use the remaining request for new depth on this feed before rotating.
      cursor.feedIndex = index;
      continue;
    }
    if (feed.nextPage > 0 && result.ids.length === feed.overlapIds.length
      && result.ids.every(id => feed.overlapIds.includes(id))) {
      feed.done = true; feed.reason = "REPEATED_PUBLIC_PAGE"; progressed += 1;
      continue;
    }
    feed.nextPage = page + 1;
    feed.overlapIds = result.ids;
    validated.add(index);
    progressed += 1;
    const anchorCount = result.ids.filter(id => input.anchors.has(id)).length;
    if (anchorCount >= 3 && anchorCount >= Math.ceil(result.ids.length / 2)) {
      feed.done = true; feed.reason = "ANCHOR_OVERLAP_UNPROVEN_ORDER";
    } else if (feed.nextPage >= AUTO_RIA_PUBLIC_RECOVERY_DEPTH) {
      feed.done = true; feed.reason = "LOCAL_DEPTH_BUDGET";
    }
  }
  const done = cursor.feeds.every(feed => feed.done);
  return { cursor, progressed, noProgressReason,
    ...(done ? { reason: cursor.feeds.some(feed => feed.reason === "REPEATED_PUBLIC_PAGE")
      ? "UNSTABLE_PAGINATION" as const : "NON_PARTITIONABLE_RANGE" as const } : {}) };
}
