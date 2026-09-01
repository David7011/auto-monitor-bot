import {
  normalizeVehicleText,
  sortListingsNewestFirst,
  type ListingObservationChannel,
  type NormalizedListing,
} from "@amb/shared";
import { env } from "../env.js";
import {
  collectorScanOptions,
  scanDeadlineReached,
  type CollectorResult,
  type CollectorScanOptions,
  type SourceCollector,
  type SourceSearchContext,
  type SourceSearchState,
} from "./base.js";
import {
  olxLocationScopes,
  regionalCoverageScopes,
  resolveOlxLocationScopes,
  uniqueLocationScopes,
} from "./olx-geo.js";
import { olxCoverageExecutionSchedule } from "./olx-coverage.js";
import { olxLaneArbiter } from "../modules/olx-lane-arbiter.js";
import type { OlxRequestClass } from "../modules/olx-request-coordinator.js";
import { collectProgressively } from "../modules/progressive-results.js";
import {
  buildOlxFeedTargets,
  coordinatorCoverageMetrics,
  fetchOlxDetailAd,
  fetchOlxFeed,
  fetchOlxHtmlFeed,
  hydrateHtmlCardOnlyAds,
  isAdsResult,
  isBlockedResult,
  isErrorResult,
  isPrimaryBlockedResult,
  olxApiPageSize,
  olxFeedTargets,
  type OlxFeedResult,
} from "./olx-feed.js";
import {
  normalizeOlxAd,
  olxPublishedAt,
  type OlxAd,
} from "./olx-normalization.js";

export {
  buildOlxFeedTargets,
  extractRenderedOlxCards,
  olxApiFeedUrls,
  parseRenderedCardDate,
} from "./olx-feed.js";
export type { OlxFeedTargetOptions } from "./olx-feed.js";
export { normalizeOlxAd } from "./olx-normalization.js";
export type { OlxAd } from "./olx-normalization.js";

export class OlxCollector implements SourceCollector {
  readonly source = "OLX" as const;
  readonly supportsNewestFirst = true;
  readonly newestFirstVerified = true;

  async collect(
    context: SourceSearchContext,
    state: SourceSearchState,
    input?: CollectorScanOptions,
  ): Promise<CollectorResult> {
    const scan = collectorScanOptions(input);
    const listings: NormalizedListing[] = [];
    const seenExternalIds = new Set<string>();
    const hotDispatchedExternalIds = new Set<string>();
    const now = new Date();
    const semanticWarnings: string[] = [];
    const coverageOnly = Boolean(scan.coverageOnly);
    const suppressBackground = Boolean(scan.olxProtectionCooling || scan.olxProtectionProbe);
    const resolvedLocations = suppressBackground
      ? { scopes: olxLocationScopes(context), warnings: [] }
      : await resolveOlxLocationScopes(context);
    semanticWarnings.push(...resolvedLocations.warnings);
    const isBackfill = scan.lane === "BACKFILL" && !coverageOnly;
    const coverageSchedule = olxCoverageExecutionSchedule({
          coverageOnly,
          suppressBackground,
          now,
          state,
          hasRegionalFilters: context.regions.length > 0,
          regionalIntervalSeconds: env.OLX_COVERAGE_INTERVAL_SECONDS,
          htmlIntervalSeconds: env.OLX_HTML_COVERAGE_INTERVAL_SECONDS,
          privateIntervalSeconds: env.OLX_PRIVATE_COVERAGE_INTERVAL_SECONDS,
        });
    const coverageDue = coverageSchedule.regionalDue;
    const htmlCoverageDue = coverageSchedule.htmlDue;
    const privateCoverageDue = coverageSchedule.privateDue && !env.OLX_PRIVATE_FEED_ENABLED;
    let lastRegionalCoverageAt: Date | undefined;
    let lastHtmlCoverageAt: Date | undefined;
    let htmlCoveragePausedUntil: Date | null | undefined;
    let lastPrivateCoverageAt: Date | undefined;
    const fastObservedIds = new Set<string>();
    const regionalObservedIds = new Set<string>();
    const htmlObservedIds = new Set<string>();
    const privateObservedIds = new Set<string>();
    // While recovery is pending, only the anchors frozen before the gap may
    // prove continuity. IDs learned by newer realtime runs must not close an
    // older offline window by merely overlapping each other.
    const continuityKnownExternalIds = new Set(
      state.coverageRecoveryPending && (state.coverageAnchorExternalIds?.size ?? 0) > 0
        ? state.coverageAnchorExternalIds
        : state.knownExternalIds,
    );
    let fastFeedRequests = 0;
    let regionalFeedRequests = 0;
    let htmlFeedRequests = 0;
    let privateFeedRequests = 0;
    const activeScopes = isBackfill || coverageDue
      ? uniqueLocationScopes([...resolvedLocations.scopes, ...regionalCoverageScopes(context)])
      : resolvedLocations.scopes;
    const maxCandidates = Math.max(1, Math.min(scan.maxCandidates, scan.lane === "REALTIME" ? env.OLX_MAX_NEW_PER_RUN : scan.maxCandidates));
    // The public API rejects offsets above OLX_API_MAX_OFFSET, so deeper pages
    // would only burn requests on 400 responses and HTML fallbacks.
    const maxOffsetPages = Math.max(1, Math.floor(Math.max(0, env.OLX_API_MAX_OFFSET) / olxApiPageSize()) + 1);
    const maxPages = suppressBackground
      ? 1
      : Math.min(
      maxOffsetPages,
      isBackfill
        ? scan.backfillProfile === "LIGHT"
          ? Math.max(1, scan.maxPages)
          : Math.max(1, scan.maxPages, env.OLX_BACKFILL_MAX_PAGES)
        : Math.max(1, scan.maxPages, env.OLX_REALTIME_MAX_PAGES),
      );
    let pageCount = 0;
    let requestCount = 0;
    let observedCount = 0;
    const scannedExternalIds = new Set<string>();
    let cutoffReached = false;
    let degradedReason: string | undefined;
    const depthRequestClass: OlxRequestClass = scan.recovery ? "RECOVERY" : "BACKFILL";
    // A fast scan is "anchored" once it overlaps listings from the previous
    // scan (or the freshness cutoff): that proves nothing was skipped between
    // the two scans, so pagination can stop.
    let anchored = false;
    let coverageVerificationMethod: "KNOWN_TAIL" | "CUTOFF" | "EXHAUSTED" | undefined;

    if (coverageOnly && !coverageDue && !htmlCoverageDue && !privateCoverageDue) {
      return {
        listings: [],
        scannedExternalIds: [],
        observedCount: 0,
        pageCount: 0,
        requestCount: 0,
        cutoffReached: false,
        semanticWarnings,
        coverageGap: false,
        coverageVerified: false,
        coverageStateUpdate: {},
        coverageMetrics: {
          fingerprint: context.fingerprint,
          coverageOnly: true,
          regionalDue: false,
          htmlDue: false,
          privateDue: false,
          fastFeedRequests: 0,
          regionalFeedRequests: 0,
          htmlFeedRequests: 0,
          privateFeedRequests: 0,
          fastObserved: 0,
          regionalObserved: 0,
          regionalOnlyObserved: 0,
          htmlObserved: 0,
          htmlOnlyObserved: 0,
          privateObserved: 0,
          privateOnlyObserved: 0,
          ...coordinatorCoverageMetrics(),
        },
      };
    }

    for (let page = 1; page <= maxPages; page += 1) {
      if (
        isBackfill
        && !await olxLaneArbiter.waitForBackfillWindow(
          scan.deadlineAt,
          env.OLX_BACKFILL_REALTIME_QUIET_MS,
        )
      ) {
        degradedReason = `OLX backfill yielded to realtime after ${pageCount} page(s)`;
        semanticWarnings.push(degradedReason);
        break;
      }
      if (scanDeadlineReached(scan)) {
        degradedReason = `OLX scan deadline reached after ${pageCount} page(s)`;
        semanticWarnings.push(degradedReason);
        break;
      }

      const allFeedTargets = olxFeedTargets(context, page, activeScopes);
      const feedTargets = scan.olxProtectionProbe
        ? allFeedTargets.slice(0, 1)
        : allFeedTargets;
      const directTargetKeys = new Set(
        olxFeedTargets(context, page, resolvedLocations.scopes).map((target) => target.observationTarget),
      );
      const { directTargets, regionalTargets } = partitionOlxExecutionTargets(
        feedTargets,
        directTargetKeys,
        coverageOnly,
      );
      const directRequestClass: OlxRequestClass = isBackfill ? depthRequestClass : "REALTIME";
      const directResults: OlxFeedResult[] = isBackfill
        ? await fetchOlxTargetsSequentially(directTargets, (target, index) => fetchOlxFeed(
            target.apiUrl,
            target.htmlUrl,
            index === 0,
            target.privateOnly ? "OLX_PRIVATE_API" : "OLX_PUBLIC_API",
            target.observationTarget,
            directRequestClass,
          ))
        : await collectProgressively(
            directTargets,
            (target, index) => scan.olxProtectionProbe
              ? fetchOlxHtmlFeed(
                  target.htmlUrl,
                  index === 0,
                  target.privateOnly ? "OLX_HTML_COVERAGE" : "OLX_PUBLIC_HTML",
                  target.observationTarget,
                  directRequestClass,
                )
              : fetchOlxFeed(
                  target.apiUrl,
                  target.htmlUrl,
                  index === 0,
                  target.privateOnly ? "OLX_PRIVATE_API" : "OLX_PUBLIC_API",
                  target.observationTarget,
                  directRequestClass,
                ),
            async (result) => {
              if (!scan.onHotCandidates || !isAdsResult(result)) return;
              const uncommittedHotCandidates = [...hotDispatchedExternalIds]
                .filter((externalId) => !seenExternalIds.has(externalId))
                .length;
              const hotCandidates = selectHotOlxCandidates([result], {
                now,
                publishedAfter: context.publishedAfter,
                knownExternalIds: continuityKnownExternalIds,
                seenExternalIds: new Set([
                  ...seenExternalIds,
                  ...hotDispatchedExternalIds,
                ]),
                maxCandidates: Math.max(
                  0,
                  maxCandidates - listings.length - uncommittedHotCandidates,
                ),
              });
              const hotCandidateAt = new Date();
              for (const listing of hotCandidates) {
                listing.hotCandidateAt = hotCandidateAt;
                hotDispatchedExternalIds.add(listing.externalId);
              }
              if (hotCandidates.length > 0) await scan.onHotCandidates(hotCandidates);
            },
          );
      fastFeedRequests += directTargets.length;
      for (const result of directResults) {
        if (isAdsResult(result)) for (const ad of result.ads) fastObservedIds.add(String(ad.id));
      }
      requestCount += directResults.reduce((total, result) => total + result.requestCount, 0);
      const primaryBlocked = directResults.find(isPrimaryBlockedResult);
      if (primaryBlocked) {
        return {
          listings,
          ...primaryBlocked.blocked,
          affectedUrl: primaryBlocked.url,
          pageCount,
          requestCount,
          observedCount,
          semanticWarnings,
        };
      }

      // Each direct result has already reached the hot handoff independently.
      // Regional, HTML and private reconciliation remains below that boundary.

      const regionalRequestClass: OlxRequestClass = isBackfill ? depthRequestClass : "COVERAGE";
      const regionalResults: OlxFeedResult[] = isBackfill
        ? await fetchOlxTargetsSequentially(regionalTargets, (target) => fetchOlxFeed(
            target.apiUrl,
            target.htmlUrl,
            false,
            target.privateOnly ? "OLX_PRIVATE_API" : "OLX_REGIONAL_API",
            target.observationTarget,
            regionalRequestClass,
          ))
        : await Promise.all(regionalTargets.map((target) => fetchOlxFeed(
            target.apiUrl,
            target.htmlUrl,
            false,
            target.privateOnly ? "OLX_PRIVATE_API" : "OLX_REGIONAL_API",
            target.observationTarget,
            regionalRequestClass,
          )));
      regionalFeedRequests += regionalTargets.length;
      if (coverageOnly && coverageDue && page === 1) lastRegionalCoverageAt = now;
      requestCount += regionalResults.reduce((total, result) => total + result.requestCount, 0);
      for (const result of regionalResults) {
        if (isAdsResult(result)) for (const ad of result.ads) regionalObservedIds.add(String(ad.id));
      }
      const feedResults: OlxFeedResult[] = [...directResults, ...regionalResults];

      if (page === 1) {
        const primaryHtmlResults = feedResults.filter((result) =>
          result.channel === "OLX_PUBLIC_HTML" || result.channel === "OLX_REGIONAL_HTML");
        if (primaryHtmlResults.some(isAdsResult)) {
          lastHtmlCoverageAt = now;
          htmlCoveragePausedUntil = null;
        }
        htmlFeedRequests += primaryHtmlResults.length;
        for (const result of primaryHtmlResults) {
          if (isAdsResult(result)) for (const ad of result.ads) htmlObservedIds.add(String(ad.id));
        }
      }

      // The HTML search and the public JSON feed are not perfectly identical:
      // OLX can expose a few cards in one index before the other. Once a minute,
      // merge the exact-city HTML feeds. This closes that blind spot without
      // adding browser automation or increasing the high-frequency request rate.
      if (page === 1 && htmlCoverageDue && !lastHtmlCoverageAt) {
        lastHtmlCoverageAt = now;
        const htmlTargets = olxFeedTargets(context, 1, resolvedLocations.scopes);
        const htmlResults = await Promise.all(
          htmlTargets.map((target) => fetchOlxHtmlFeed(
            target.htmlUrl,
            false,
            "OLX_HTML_COVERAGE",
            target.observationTarget,
            "COVERAGE",
          )),
        );
        requestCount += htmlResults.reduce((total, result) => total + result.requestCount, 0);
        htmlFeedRequests += htmlTargets.length;
        for (const result of htmlResults) {
          if (isAdsResult(result)) for (const ad of result.ads) htmlObservedIds.add(String(ad.id));
        }
        const htmlBlocked = htmlResults.find(isBlockedResult);
        if (htmlBlocked) {
          const pauseSeconds = htmlBlocked.blocked.captchaDetected
            ? Math.max(60, env.CAPTCHA_PAUSE_SECONDS)
            : Math.max(30, env.RATE_LIMIT_PAUSE_BASE_SECONDS);
          htmlCoveragePausedUntil = new Date(now.getTime() + pauseSeconds * 1000);
          semanticWarnings.push(
            `OLX HTML-сверка приостановлена на ${pauseSeconds} с; realtime продолжает только подтверждённые успешные каналы`,
          );
        } else {
          htmlCoveragePausedUntil = null;
        }
        const hydration = await hydrateHtmlCardOnlyAds(
          htmlResults,
          continuityKnownExternalIds,
          scan.deadlineAt,
        );
        requestCount += hydration.requestCount;
        if (hydration.failedCount > 0) {
          semanticWarnings.push(
            `OLX HTML-сверка: ${hydration.failedCount} карточка(и) не успели пройти безопасную детальную проверку`,
          );
        }
        feedResults.push(...htmlResults.filter((result) => !isBlockedResult(result)));
      }

      // The owner-filtered feed is a low-frequency shadow lane. It is not part
      // of the four-second hot path, but catches temporary index differences
      // without doubling every realtime scan or provoking protection pages.
      if (page === 1 && privateCoverageDue) {
        lastPrivateCoverageAt = now;
        const privateTargets = buildOlxFeedTargets(context, 1, resolvedLocations.scopes, {
          pageSize: olxApiPageSize(),
          includePrivateFeed: true,
        }).filter((target) => target.privateOnly);
        const privateResults = await Promise.all(
          privateTargets.map((target) => fetchOlxHtmlFeed(
            target.htmlUrl,
            false,
            "OLX_HTML_COVERAGE",
            target.observationTarget,
            "COVERAGE",
          )),
        );
        privateFeedRequests += privateTargets.length;
        requestCount += privateResults.reduce((total, result) => total + result.requestCount, 0);
        for (const result of privateResults) {
          if (isAdsResult(result)) for (const ad of result.ads) privateObservedIds.add(String(ad.id));
        }
        feedResults.push(...privateResults);
      }

      const successfulFeeds = feedResults.filter(isAdsResult);
      if (successfulFeeds.length === 0) {
        if (coverageOnly) {
          const failedCoverageFeeds = feedResults.filter((result) => isBlockedResult(result) || isErrorResult(result));
          degradedReason = failedCoverageFeeds.length > 0
            ? `${failedCoverageFeeds.length} OLX coverage feed(s) returned no usable result`
            : "OLX coverage cycle had no due or usable feed";
          semanticWarnings.push(degradedReason);
          return {
            listings,
            scannedExternalIds: [...scannedExternalIds],
            observedCount,
            pageCount,
            requestCount,
            cutoffReached: false,
            semanticWarnings,
            limited: true,
            limitedReason: degradedReason,
            coverageGap: false,
            coverageVerified: false,
            coverageStateUpdate: {
              lastRegionalCoverageAt,
              lastHtmlCoverageAt,
              htmlCoveragePausedUntil,
              lastPrivateCoverageAt,
            },
            coverageMetrics: {
              fingerprint: context.fingerprint,
              coverageOnly: true,
              regionalDue: coverageSchedule.regionalDue,
              htmlDue: coverageSchedule.htmlDue,
              privateDue: privateCoverageDue,
              fastFeedRequests,
              regionalFeedRequests,
              htmlFeedRequests,
              privateFeedRequests,
              fastObserved: fastObservedIds.size,
              regionalObserved: regionalObservedIds.size,
              regionalOnlyObserved: [...regionalObservedIds].filter((id) => !fastObservedIds.has(id)).length,
              htmlObserved: htmlObservedIds.size,
              htmlOnlyObserved: [...htmlObservedIds].filter((id) => !fastObservedIds.has(id)).length,
              privateObserved: privateObservedIds.size,
              privateOnlyObserved: [...privateObservedIds].filter((id) => !fastObservedIds.has(id)).length,
              ...coordinatorCoverageMetrics(),
            },
          };
        }
        const blocked = feedResults.find(isBlockedResult);
        if (blocked) {
          return {
            listings,
            ...blocked.blocked,
            affectedUrl: blocked.url,
            pageCount,
            requestCount,
            observedCount,
            semanticWarnings,
          };
        }

        const errors = feedResults
          .filter(isErrorResult)
          .map((result) => `${result.url}: ${result.error.message}`)
          .join("; ");
        throw new Error(errors ? `OLX search failed: ${errors}` : "OLX search failed: no feeds returned listings");
      }
      if (coverageDue && page === 1) lastRegionalCoverageAt = now;

      const secondaryBlockedFeeds = feedResults.filter((result) => !result.primary && isBlockedResult(result));
      if (secondaryBlockedFeeds.length > 0) {
        degradedReason = `${secondaryBlockedFeeds.length} дополнительная OLX-лента временно защищена`;
        semanticWarnings.push(degradedReason);
      }

      if (page === 1 && successfulFeeds.every((feed) => feed.ads.length < env.OLX_MIN_EXPECTED_PAGE_ITEMS)) {
        degradedReason = `OLX вернул подозрительно короткую первую страницу: ${successfulFeeds.map((feed) => feed.ads.length).join(", ")}`;
        semanticWarnings.push(degradedReason);
      }

      pageCount += 1;
      let observedOnPage = 0;
      let pageAnchored = true;
      let pageCutoff = Boolean(context.publishedAfter);
      for (const feed of successfulFeeds) {
        const selection = selectOlxCandidates(feed.ads, {
          now,
          publishedAfter: context.publishedAfter,
          knownExternalIds: continuityKnownExternalIds,
          seenExternalIds,
          maxCandidates: Math.max(0, maxCandidates - listings.length),
          observationChannel: feed.channel,
          observationTarget: feed.observationTarget,
          requestStartedAt: feed.requestStartedAt,
          firstByteAt: feed.firstByteAt,
        });
        listings.push(...selection.listings);
        for (const externalId of selection.scannedExternalIds) scannedExternalIds.add(externalId);
        observedCount += selection.observedCount;
        observedOnPage += selection.observedCount;
        const exhausted = feed.ads.length === 0;
        const knownTailAnchored = selection.identifiableCount > 0 &&
          (selection.allKnown || selection.knownTailStreak >= Math.max(1, env.KNOWN_LISTING_STOP_THRESHOLD));
        // OLX may mix promoted old adverts into an otherwise fresh page. A
        // single known/old item therefore proves nothing about the next page.
        // Realtime stops only after a continuous known tail (or an all-known
        // feed), and backfill stops only when every identifiable advert in all
        // successful feeds is demonstrably older than the cutoff.
        if (!(exhausted || knownTailAnchored) || selection.candidateLimitReached) pageAnchored = false;
        if (!(exhausted || selection.fullyBeforeCutoff) || selection.candidateLimitReached) pageCutoff = false;
      }

      const feedErrors = feedResults.filter(isErrorResult);
      if (feedErrors.length > 0) {
        pageAnchored = false;
        pageCutoff = false;
        degradedReason = `${feedErrors.length} OLX feed(s) failed on page ${page}`;
        semanticWarnings.push(degradedReason);
      }
      const feedsExhausted = successfulFeeds.every((feed) => feed.ads.length === 0);
      if (feedsExhausted) {
        cutoffReached = Boolean(context.publishedAfter);
        anchored = true;
        coverageVerificationMethod = "EXHAUSTED";
        break;
      }
      if (observedOnPage === 0) {
        if (page === 1) semanticWarnings.push("OLX returned no parseable adverts on the first page");
      }
      if (listings.length >= maxCandidates) {
        anchored = pageAnchored;
        break;
      }
      if (!isBackfill && !coverageOnly && shouldStopOlxRealtimePage(pageAnchored, pageCutoff)) {
        anchored = true;
        if (pageCutoff) {
          cutoffReached = true;
          coverageVerificationMethod = "CUTOFF";
        } else {
          coverageVerificationMethod = "KNOWN_TAIL";
        }
        break;
      }
      // Newest-first order means one page fully past the freshness cutoff ends
      // the useful backfill depth as well.
      if (isBackfill && pageCutoff) {
        cutoffReached = true;
        coverageVerificationMethod = "CUTOFF";
        break;
      }
      if (isBackfill && state.coverageRecoveryPending && pageAnchored) {
        anchored = true;
        coverageVerificationMethod = "KNOWN_TAIL";
        break;
      }
      if (isBackfill && page < maxPages) {
        const baseDelay = Math.max(0, env.OLX_BACKFILL_PAGE_DELAY_MS);
        await delay(baseDelay + Math.floor(Math.random() * Math.max(1, Math.round(baseDelay * 0.35))));
      }
    }

    const hasContinuityEvidence = continuityKnownExternalIds.size > 0 || state.coverageRecoveryPending;
    if (!isBackfill && !coverageOnly && !anchored && hasContinuityEvidence && observedCount > 0) {
      semanticWarnings.push(
        `OLX realtime window overflow: ${pageCount} page(s) scanned without overlapping known listings; deep backfill will recover the tail`,
      );
    }

    return {
      listings: sortListingsNewestFirst(listings),
      scannedExternalIds: [...scannedExternalIds],
      observedCount,
      pageCount,
      requestCount,
      cutoffReached,
      semanticWarnings,
      limited: Boolean(degradedReason),
      limitedReason: degradedReason,
      coverageGap: !coverageOnly && !isBackfill && !anchored && hasContinuityEvidence && observedCount > 0,
      coverageVerified: !coverageOnly && (anchored || cutoffReached),
      coverageVerificationMethod: !coverageOnly && (anchored || cutoffReached)
        ? coverageVerificationMethod ?? (cutoffReached ? "CUTOFF" : "KNOWN_TAIL")
        : undefined,
      coverageStateUpdate: {
        lastRegionalCoverageAt,
        lastHtmlCoverageAt,
        htmlCoveragePausedUntil,
        lastPrivateCoverageAt,
      },
      coverageMetrics: {
        fingerprint: context.fingerprint,
        coverageOnly,
        regionalDue: coverageSchedule.regionalDue,
        htmlDue: coverageSchedule.htmlDue,
        privateDue: privateCoverageDue,
        fastFeedRequests,
        regionalFeedRequests,
        htmlFeedRequests,
        privateFeedRequests,
        fastObserved: fastObservedIds.size,
        regionalObserved: regionalObservedIds.size,
        regionalOnlyObserved: [...regionalObservedIds].filter((id) => !fastObservedIds.has(id)).length,
        htmlObserved: htmlObservedIds.size,
        htmlOnlyObserved: [...htmlObservedIds].filter((id) => !fastObservedIds.has(id)).length,
        privateObserved: privateObservedIds.size,
        privateOnlyObserved: [...privateObservedIds].filter((id) => !fastObservedIds.has(id)).length,
        ...coordinatorCoverageMetrics(),
      },
    };
  }
}

export function partitionOlxExecutionTargets<T extends { observationTarget: string }>(
  targets: readonly T[],
  directTargetKeys: ReadonlySet<string>,
  coverageOnly: boolean,
): { directTargets: T[]; regionalTargets: T[] } {
  return {
    directTargets: coverageOnly
      ? []
      : targets.filter((target) => directTargetKeys.has(target.observationTarget)),
    regionalTargets: targets.filter((target) => !directTargetKeys.has(target.observationTarget)),
  };
}

async function fetchOlxTargetsSequentially<T>(
  targets: readonly T[],
  fetchTarget: (target: T, index: number) => Promise<OlxFeedResult>,
): Promise<OlxFeedResult[]> {
  const results: OlxFeedResult[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    if (target) results.push(await fetchTarget(target, index));
  }
  return results;
}

function selectHotOlxCandidates(
  feeds: readonly Extract<OlxFeedResult, { ads: OlxAd[] }>[],
  options: {
    now: Date;
    publishedAfter?: Date;
    knownExternalIds: ReadonlySet<string>;
    seenExternalIds: ReadonlySet<string>;
    maxCandidates: number;
  },
): NormalizedListing[] {
  const candidates: NormalizedListing[] = [];
  // Preview the normal selection without mutating the collector's durable
  // page bookkeeping; the full pass below remains the single source of truth.
  const previewSeen = new Set(options.seenExternalIds);
  for (const feed of feeds) {
    const selection = selectOlxCandidates(feed.ads, {
      now: options.now,
      publishedAfter: options.publishedAfter,
      knownExternalIds: options.knownExternalIds,
      seenExternalIds: previewSeen,
      maxCandidates: Math.max(0, options.maxCandidates - candidates.length),
      observationChannel: feed.channel,
      observationTarget: feed.observationTarget,
      requestStartedAt: feed.requestStartedAt,
      firstByteAt: feed.firstByteAt,
    });
    candidates.push(...selection.listings);
    if (candidates.length >= options.maxCandidates) break;
  }
  return sortListingsNewestFirst(candidates);
}

export type OlxMarketResearchQuery = {
  brand: string;
  model: string;
  year?: number;
  engineVolume?: number;
  excludeExternalId?: string;
};

export async function fetchOlxMarketComparables(query: OlxMarketResearchQuery): Promise<NormalizedListing[]> {
  const context: SourceSearchContext = {
    source: "OLX",
    fingerprint: "market-research",
    filterIds: [],
    brand: query.brand,
    models: [query.model],
    bodyTypes: [],
    fuelTypes: [],
    gearboxes: [],
    driveTypes: [],
    colors: [],
    regions: [],
    cities: [],
    keywords: [],
    excludeKeywords: [],
    freshnessMode: "ALL_TIME",
    initialWindowBehavior: "SKIP_EXISTING",
    maxInitialWindowNotifications: 0,
  };
  const results = new Map<string, NormalizedListing>();
  const maxPages = Math.max(1, Math.min(10, env.MARKET_RESEARCH_OLX_MAX_PAGES));
  const deadlineAt = Date.now() + Math.max(2_000, env.MARKET_RESEARCH_DEADLINE_MS);

  for (let page = 1; page <= maxPages && results.size < env.MARKET_RESEARCH_MAX_COMPARABLES; page += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 250) break;
    const target = olxFeedTargets(context, page, [{}])[0];
    if (!target) break;
    const feed = await fetchOlxFeed(
      target.apiUrl,
      target.htmlUrl,
      true,
      "OLX_PUBLIC_API",
      target.observationTarget,
      "ENRICHMENT",
    );
    if (!isAdsResult(feed)) {
      if (results.size === 0) {
        const reason = isBlockedResult(feed) ? feed.blocked.limitedReason : feed.error.message;
        throw new Error(`OLX market research unavailable: ${reason ?? "unknown response"}`);
      }
      break;
    }
    if (feed.ads.length === 0) break;

    for (const ad of feed.ads) {
      const listing = normalizeOlxAd(ad);
      if (!listing || listing.externalId === query.excludeExternalId || !isOlxMarketComparable(listing, query)) continue;
      results.set(listing.externalId, listing);
      if (results.size >= env.MARKET_RESEARCH_MAX_COMPARABLES) break;
    }
  }

  return [...results.values()];
}

export async function fetchOlxDetailListing(
  url: string,
  now = new Date(),
  requestClass: OlxRequestClass = "RECOVERY",
): Promise<NormalizedListing | undefined> {
  const detail = await fetchOlxDetailAd(url, requestClass);
  return detail ? normalizeOlxAd(detail, now) : undefined;
}

function isOlxMarketComparable(listing: NormalizedListing, query: OlxMarketResearchQuery): boolean {
  if (!listing.priceNormalized || listing.priceNormalized <= 0) return false;
  const brand = normalizeVehicleText(query.brand);
  const model = normalizeVehicleText(query.model);
  const candidateBrand = normalizeVehicleText(listing.brand ?? listing.title ?? "");
  const candidateModel = normalizeVehicleText([listing.model, listing.title].filter(Boolean).join(" "));
  if (!candidateBrand.includes(brand) || !candidateModel.includes(model)) return false;
  if (query.year && (!listing.year || Math.abs(listing.year - query.year) > 2)) return false;
  if (query.engineVolume && listing.engineVolume && Math.abs(listing.engineVolume - query.engineVolume) > 0.5) return false;
  return true;
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export function selectOlxCandidates(
  ads: readonly OlxAd[],
  options: {
    now: Date;
    publishedAfter?: Date;
    knownExternalIds: ReadonlySet<string>;
    seenExternalIds?: Set<string>;
    maxCandidates: number;
    observationChannel?: ListingObservationChannel;
    observationTarget?: string;
    requestStartedAt?: Date;
    firstByteAt?: Date;
    hotCandidateAt?: Date;
  },
): {
  listings: NormalizedListing[];
  observedCount: number;
  cutoffEncountered: boolean;
  knownEncountered: boolean;
  identifiableCount: number;
  knownTailStreak: number;
  allKnown: boolean;
  fullyBeforeCutoff: boolean;
  candidateLimitReached: boolean;
  scannedExternalIds: string[];
} {
  const listings: NormalizedListing[] = [];
  const seen = options.seenExternalIds ?? new Set<string>();
  let observedCount = 0;
  let cutoffEncountered = false;
  let knownEncountered = false;
  let identifiableCount = 0;
  let allKnown = true;
  let fullyBeforeCutoff = Boolean(options.publishedAfter);
  let candidateLimitReached = false;
  const scannedExternalIds: string[] = [];
  const orderingSignals: Array<{ known: boolean }> = [];

  for (const ad of ads) {
    const externalId = String(ad.id ?? "");
    if (!externalId) {
      allKnown = false;
      fullyBeforeCutoff = false;
      continue;
    }

    identifiableCount += 1;
    const known = options.knownExternalIds.has(externalId);
    orderingSignals.push({ known });
    knownEncountered ||= known;
    allKnown &&= known;

    const publishedAt = olxPublishedAt(ad);
    const beforeCutoff = Boolean(options.publishedAfter && publishedAt && publishedAt < options.publishedAfter);
    cutoffEncountered ||= beforeCutoff;
    if (!beforeCutoff) fullyBeforeCutoff = false;

    if (known) scannedExternalIds.push(externalId);
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    observedCount += 1;

    // Known IDs are the dominant realtime path. Avoid full parameter and text
    // normalization until an advert is actually new for this search context.
    if (known) continue;

    const listing = normalizeOlxAd(ad, options.now);
    if (!listing) continue;
    listing.observationChannel = options.observationChannel;
    listing.observationTarget = options.observationTarget;
    listing.requestStartedAt = options.requestStartedAt;
    listing.firstByteAt = options.firstByteAt;
    listing.hotCandidateAt = options.hotCandidateAt;
    if (beforeCutoff) {
      scannedExternalIds.push(externalId);
      continue;
    }
    if (listings.length >= Math.max(0, options.maxCandidates)) {
      candidateLimitReached = true;
      continue;
    }
    listings.push(listing);
    scannedExternalIds.push(externalId);
  }

  let knownTailStreak = 0;
  for (let index = orderingSignals.length - 1; index >= 0; index -= 1) {
    if (!orderingSignals[index]?.known) break;
    knownTailStreak += 1;
  }

  return {
    listings,
    observedCount,
    cutoffEncountered,
    knownEncountered,
    identifiableCount,
    knownTailStreak,
    allKnown: identifiableCount > 0 && allKnown,
    fullyBeforeCutoff: identifiableCount > 0 && fullyBeforeCutoff,
    candidateLimitReached,
    scannedExternalIds,
  };
}

export function shouldStopOlxRealtimePage(pageAnchored: boolean, pageFullyBeforeCutoff: boolean): boolean {
  return pageAnchored || pageFullyBeforeCutoff;
}
