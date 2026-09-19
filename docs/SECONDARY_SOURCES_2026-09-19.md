# Secondary source repair, 2026-09-19

## Confirmed production evidence

- AUTO.RIA public mode is operational, without an API key. A production realtime run at 20:37:19 UTC recorded one new matching advert. LIMITED describes timestamp/continuity uncertainty, not an HTTP failure.
- Read-only one-page collector probes returned 20 normalized AUTO.RIA adverts and 15 AutoMoto adverts, one request per source, without CAPTCHA or rate limiting. These probes did not persist adverts or send notifications.
- RST on this HP returned HTTP 403, `cf-mitigated: challenge`, zero advert cards. Its historical pause expired, but availability is still not restored. Do not relabel this as ACTIVE or clear the protection state based on elapsed time alone.

## Changes

- AUTO.RIA bounded backfill no longer exits merely because a page contains only known IDs. Promoted/refreshed ordering cannot prove that deeper pages contain no new IDs. Existing three-page maximum, deadline and candidate cap remain; realtime stays one page.
- AutoMoto day-only dates use the beginning of the calendar day in Europe/Kyiv, with LOW confidence, instead of fabricated noon UTC. This fixes morning TODAY rejection and validates impossible calendar dates. Exact LAST_HOUR/rolling-window completeness remains unproven; no precise timestamp is invented.
- Added read-only diagnostics: `amb.cmd --filter @amb/worker exec tsx src/maintenance/secondary-source-audit-cli.ts`. Explicit `--probe-public` adds one public page request for each of AUTO.RIA and AutoMoto, with no persistence/notification callback. It never probes OLX or RST.

## External documentation and remaining limits

- https://developers.ria.com/docs/ requires an API key for the official API. Public mode remains the default strategy; an API subscription is not silently enabled.
- https://automoto.ua/uk/ exposes calendar publication dates. These do not prove exact publication time or strict newest-first order.
- https://rst.ua/ukr/oldcars/ remains challenge-blocked from HP. Restoring RST requires an available permitted feed/access channel or successful normal access followed by a controlled collector check. Search-engine cached pages are not live-feed evidence.

LIMITED stays visible for both working public collectors until the underlying guarantees can actually be established.
