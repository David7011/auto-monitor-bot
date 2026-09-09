# Auto Monitor Bot — full performance and reliability audit (2026-09-09)

## Outcome

The production build on the HP was upgraded and restarted through the installed SYSTEM task. PostgreSQL 18.6, Redis 8.8.0, pinned Node.js 24.18.0 and pnpm 10.34.5 were preserved. No database, Redis persistence, runtime or secret archive was copied or replaced during this audit.

The system is materially safer and faster on its critical path, but no public marketplace monitor can honestly guarantee zero missed adverts. The remaining external limitation is RST's real Cloudflare challenge. OLX remains healthy and isolated from that failure.

## P0/P1 defects corrected

1. OLX realtime was coupled to an old recovery boundary. A pending historical gap could make every hot poll walk old pages again. Realtime now stops at the current known tail; only BACKFILL owns the frozen historical anchors.
2. Pending recovery bypassed the configured protection/unresolved cadence. Recovery urgency now respects `backfillDue`; a 429 cannot create a deep-scan request storm.
3. Historical scheduling was awaited by the realtime tick. Evidence queries, coverage and recovery planning now run in one guarded background scheduler, with RUNNING/generation checks before enqueue and state writes.
4. Concurrent identical OLX requests were duplicated. Matching in-flight HTML/API requests are now collapsed inside a worker process. Completed responses are never cached, priorities are isolated, and each subscriber receives independent result objects.
5. OLX parsed rendered cards even when the same IDs were already present in structured state. Those duplicate parsing and normalization passes are skipped while rendered-only IDs remain covered.
6. An old advert timestamp could start a speculative freshness hedge. The hedge now requires actual HTTP `Age` evidence; a naturally quiet feed does not generate the extra request.
7. Rendered OLX date-only values were synthesized at noon and marked HIGH. Structured timestamps remain HIGH, `HH:mm` is MEDIUM, date-only is LOW, invalid calendar dates are rejected, and LOW values cannot prove a recovery cutoff.
8. Protection detection could classify ordinary `429` text or CAPTCHA JavaScript/templates inside valid JSON as a block. HTTP status, `Retry-After`, Cloudflare's documented `cf-mitigated: challenge`, and bounded structural evidence are now kept distinct.
9. AUTO.RIA was disabled without an API key, and its API request used incorrect body/fuel parameter names. Public SSR search is now the default, needs no key, uses one page request with no per-ad detail storm, and keeps publication confidence UNKNOWN/FIRST_SEEN. Official API remains opt-in; only a structured API-key rejection falls back to public mode. Real CAPTCHA/429 is not hidden. Public mode uses its 60-second cadence instead of the official API quota interval.
10. Telegram acceptance could be overwritten by a later local projection failure or reclaimed by a concurrent sender. The external receipt is persisted first, compare-and-set requires `messageId = null`, retries heal local projections without sending again, and accepted-receipt recovery cannot downgrade `ENRICHED` listings to `SENT`.
11. Non-admin restart could fail to see SYSTEM processes, leave stale PID state and create duplicate runtimes. The lifecycle now elevates before mutation, stops the SYSTEM supervisor first, checks native exit codes, deploys, proves readiness, then reloads the task.
12. The isolated resilience test ignored the project-pinned Redis. It now uses `.runtime/redis-modern/redis-server.exe` first. Vitest defaults also point accidental database/Redis access to a closed test endpoint and clear Telegram credentials.

## Measured evidence

### Before

Artifact: `.runtime/audit/before-1788930806983.json`, 24-hour window ending 2026-09-09 05:13:26Z.

- OLX realtime: 2,591 runs, 3,300 requests, 142,315 observed cards, 52 accepted observations.
- Request → first byte p50 1,538 ms; first byte → candidate p50 815 ms.
- Candidate → durable journal p50 5 ms; journal → Telegram API acceptance p50 352 ms, p95 1,923 ms.
- Request → Telegram API acceptance p50 2,792 ms, p95 5,494 ms.
- Realtime run duration p50 2,679 ms, p95 5,438 ms; successful start gap p50 17,452 ms, p95 23,481 ms.
- Source-reported publication → Telegram acceptance p50 994,926 ms for 52 HIGH timestamps. This includes source-side moderation/indexing and a 6.46-hour laptop suspension, so it is not a pure code latency measurement.

### After the main deployment

Artifact: `.runtime/audit/after-1788933325175.json`, 2026-09-09 05:50:30Z–05:55:24Z.

- OLX realtime: 14/14 successful runs, 16 requests, 754 observed cards, no 403/429/challenge, no new advert in this short window.
- Realtime duration p50 2,628 ms. The small-sample p95 was 8,956 ms during concurrent post-deploy coverage; start gap p50 20,964 ms, within the configured 20 ± 4 second cadence.
- No post-deploy OLX advert appeared, therefore a new request → Telegram latency sample cannot honestly be claimed yet.
- OLX recovery state: no pending boundary; parser HEALTHY; 41 durable recovery windows VERIFIED.
- AUTO.RIA public: two scans, 40 observations; 20 previously unseen current cards were accepted once on the first scan and zero duplicated on the second. First-seen → Telegram API acceptance p50 530 ms, p95 534 ms; request start → acceptance 1,616 ms. Exact original publication time is intentionally not claimed.
- Final public-cadence evidence (`.runtime/audit/after-final-1788934144246.json`): two further AUTO.RIA scans, two requests, 40 observations, zero duplicates; measured start gap 64,161 ms, within the configured 60 ± 5 second cadence.

The Telegram metric is Bot API acceptance, not proof that a phone rendered or was read by a human; Telegram's Bot API returns a Message on successful `sendMessage`, but provides no client-read receipt.

## Verification performed

- Dependency audit: no known production vulnerabilities after narrowly updating Next.js to 16.3.3 and sharp to 0.35.4. This addresses the applicable maintainer advisories [GHSA-p293-qw3h-jr36](https://github.com/advisories/GHSA-p293-qw3h-jr36), [GHSA-2xp9-vwfh-vxw4](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4), and [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c).
- Full quality gate: Prisma schema/generation, documentation drift, TypeScript, ESLint, PowerShell syntax, backup encryption/tamper tests, CI policy, 80 test files / 395 tests (394 were included in the last coverage run; the final cadence regression also passed), and isolated production build passed.
- Resilience acceptance: all 38 migrations applied to a fresh isolated PostgreSQL; isolated Redis; healthy delivery, Telegram failure, Redis failure, PostgreSQL failure before/after journal, and DB loss after Telegram acceptance passed. Six deterministic OLX IDs were each requested once and ended NOTIFIED or in an explicit recoverable state.
- Browser E2E: 4 passed on Chromium (desktop/mobile navigation, authenticated screens and token non-disclosure); the intentionally state-changing stop/start test was skipped. The real SYSTEM restart was instead exercised three times and finished with readiness checks.
- Runtime security: protected ACLs and all four SYSTEM task definitions passed.
- Encrypted pre-deploy database backup: `.runtime/backups/database-20260909-084732.ambbak`.

## Current production state and remaining risks

- OLX: ACTIVE, parser healthy, no failed/retry backlog, realtime independent from RST/AUTO.RIA/backfill.
- AUTO.RIA: operational in public LIMITED mode. LIMITED means publication timestamp/complete historical coverage is not provable; it is not a transport failure.
- RST: still blocked by a genuine `cf-mitigated` Cloudflare challenge from this HP. A single bounded check of the public mobile host also returned HTTP 403, and no official advert API/RSS/sitemap was found. It remains isolated and paused; fabricating browser fingerprints or using CAPTCHA-solving services was deliberately not added. Cloudflare documents `cf-mitigated: challenge` as the authoritative challenge-page signal: [Detect a Challenge Page response](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/).
- Cars.ua: ACTIVE. AutoMoto: operational LIMITED because it exposes a day without exact publication time.
- In-flight request collapsing is process-local. Cross-process collapsing would require a distributed response-sharing protocol and is not justified while the single OLX leader owns collection.
- A crash after Telegram accepts a message but before any durable local receipt remains theoretically ambiguous because Telegram does not offer an idempotency key for `sendMessage`. The implemented receipt-first/CAS recovery closes the local-DB projection and concurrent-reclaim cases, not that external impossibility window.
- Public pages and source-side moderation/indexing provide no contractual completeness or zero-delay guarantee. “No misses” must continue to be evaluated with coverage reconciliation, durable recovery boundaries and measured canaries, not declared as an absolute property.

HTTP retry behavior follows `Retry-After` semantics from [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585), and request collapsing/HTTP Age interpretation follows [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html).
