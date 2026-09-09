# Auto Monitor Bot hot-path audit — 2026-09-09

## Executive conclusion

The current design should not be rewritten in Go. The measured OLX path is dominated by the remote response and by the interval before OLX exposes a listing, while the active Node.js worker is not CPU-saturated. Two unnecessary PostgreSQL round trips were found before first delivery and removed without weakening strong deduplication or Telegram delivery leasing. Fine-grained, durable p50/p95/p99 telemetry was added so future changes can be accepted or rejected using live evidence.

The safe optimization is incremental:

1. preserve the current Node.js/TypeScript architecture;
2. keep one newest-first OLX realtime page and progressive handoff;
3. keep OLX realtime ahead of recovery, coverage, enrichment and other sources;
4. remove optional database work from the notification critical path;
5. collect a fresh post-deployment cohort before changing the 20-second cadence.

## Scope and method

The audit traced `OLX request → response headers → body read → parse → hot candidate → durable journal → filter → strong dedup → listing persistence → Telegram request → Telegram API acceptance`.

Evidence sources:

- production database timestamps and collector-run records from the HP;
- production health, queue, connection-pool and worker-heartbeat diagnostics;
- code-path inspection of the OLX collector, observation journal, duplicate guard, notification dispatcher and Telegram lease;
- an isolated PostgreSQL 18.6 + Redis 8.8.0 fault-injection stand;
- a 40-iteration alternating A/B database benchmark;
- official Node.js, PostgreSQL, Prisma, Go and Telegram documentation.

The benchmark uses `performance.now()`, the high-resolution monotonic clock documented by [Node.js performance hooks](https://nodejs.org/api/perf_hooks.html). PostgreSQL query plans should be validated with `EXPLAIN (ANALYZE, BUFFERS)` when a query is suspected; PostgreSQL documents that `EXPLAIN ANALYZE` executes the statement and reports actual timing, while also adding profiling overhead ([PostgreSQL 18 EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)).

## Rollback point

- Immutable base commit: `4ab8ef121b2bd0a5adb0e81d82f34722328ca0a3`
- Rollback branch: `rollback/pre-hotpath-audit-20260909`
- Annotated rollback tag: `pre-hotpath-audit-20260909`
- Audit branch: `perf/hot-path-audit-20260909`

Both rollback refs were pushed before implementation.

## BEFORE: production evidence

Primary baseline artifact: `.runtime/audit/hotpath-before-1788953148649.json` in the production checkout. The larger collector window contained 923 successful OLX realtime runs and 47,631 observed cards, with 19 new observations and no OLX challenge/rate-limit/access-denied response in that window.

| Metric | p50 | p95 | p99 / max | Sample |
|---|---:|---:|---:|---:|
| OLX realtime collector run | 2,705 ms | 5,667 ms | max 9,391 ms | 923 |
| Successful OLX run start gap | 16,314 ms | 22,786 ms | long host gap excluded from interpretation | 922 |
| Request start → response headers | 1,784 ms | 2,783 ms | 2,783 ms | 91 |
| Response headers → hot candidate | 1,135 ms | 1,640 ms | 2,640 ms | 91 |
| Hot candidate → durable journal | 6 ms | 311 ms | 454 ms | 91 |
| Durable journal → Telegram acceptance | 379 ms | 1,923 ms | 1,923 ms | 61 |
| Request start → Telegram acceptance | 3,333 ms | 5,494 ms | 5,494 ms | 61 |
| Source timestamp → first local observation | 1,026,320 ms | 9,703,350 ms | 19,920,781 ms | 91 |

The source-timestamp metric is not a pure local-latency measurement. It includes OLX publication timestamp precision, OLX indexing/exposure delay, polling phase and local processing. Its much larger magnitude proves that a language rewrite cannot solve the dominant end-to-end delay by itself.

The pre-change worker heartbeat showed event-loop utilization of 4.12% on the active hot worker and 0.17% on standby, with p95 event-loop delay around 34 ms. The active hot worker used about 229 MB working set; the standby about 29 MB. PostgreSQL pool diagnostics reported zero waiters and approximately 1 ms health-query latency. Every BullMQ queue had zero waiting, active, delayed, prioritized, failed and recent-failed jobs.

## Database call audit

On the normal new-listing path, the old implementation performed these database operations before calling Telegram:

1. observation upsert;
2. redundant observation `findUnique` for retained deduplication;
3. filter load on cache miss;
4. observation evaluation upsert;
5. strong duplicate query;
6. possible-duplicate query;
7. listing create and nested matches;
8. observation outcome update;
9. Telegram notification lease lookup plus conditional lease write;
10. source-observation `telegramRequestedAt` write.

Not all calls can be removed safely. The durable observation boundary, strong identity deduplication, listing uniqueness and Telegram lease protect against missed or repeated delivery. The Bot API `sendMessage` method documents its accepted parameters but no idempotency-key parameter; therefore the local durable lease and acceptance receipt remain necessary ([Telegram Bot API — sendMessage](https://core.telegram.org/bots/api#sendmessage)).

Two calls were unnecessary on the first-send path:

- The observation upsert already knows the retained decision, so its selected result now replaces the immediately following `findUnique`.
- A `POSSIBLE` duplicate never suppressed delivery; its title/price/year query now runs in post-send enrichment and only annotates the stored listing. Strong source ID, canonical URL, VIN and plate deduplication remains inline.

Prisma documents that its PostgreSQL driver adapter uses a connection pool and warns that excessive parallel queries can exhaust it ([Prisma connection pool](https://docs.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/databases-connections/connection-pool)). Production already reuses a bounded pool with no observed waiters, so raising pool size is not justified.

### A/B database benchmark

The isolated benchmark alternated the legacy and optimized sequences for 40 iterations to reduce warm-up/order bias.

| Sequence | SQL round trips | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|
| Legacy: upsert + retained read + strong lookup + possible lookup | 4 | 3.01 ms | 4.79 ms | 46.99 ms | 46.99 ms |
| Optimized: upsert-with-result + strong lookup | 2 | 1.97 ms | 3.22 ms | 6.02 ms | 6.02 ms |

Measured change: p50 improved about 34.6%, p95 about 32.7%, and the observed p99 about 87.2%. The p99 sample is small and must not be treated as a production SLO; it is evidence that the change is not slower and halves this database subpath's round trips.

## New instrumentation

Every metric summary now includes p99. Two nullable timestamps were added to the durable observation journal:

- `bodyReceivedAt`: complete bounded body read and decode;
- `parsedAt`: JSON/HTML parsing completed.

The dashboard and audit CLI now expose:

- request start → response headers;
- response headers → body received;
- body received → parsed;
- parsed → hot candidate;
- hot candidate → durable journal;
- durable journal → filter completed;
- filter/dispatch → Telegram request;
- Telegram request → Telegram API acceptance;
- request start → Telegram API acceptance.

This separation is essential: the former `firstByte → hotCandidate` number combined network body transfer, decode, HTML/JSON parsing and candidate selection. A parser rewrite or worker thread is justified only if the new `bodyReceived → parsed` p95/p99 becomes material.

## OLX architecture findings

### What is already correct

- Realtime scans one newest-first page and uses early exit against known IDs.
- A progressive callback hands a new candidate to the pipeline before the rest of the scan finishes.
- Identical concurrent feed requests are coalesced without a stale TTL cache.
- HTTP connections are reused through a bounded Undici agent.
- The OLX origin coordinator serializes pressure, prioritizes realtime and preempts background work.
- Backfill/coverage state is durable; an unprovable boundary becomes `UNRESOLVED` rather than causing infinite deep scans.
- Enrichment and market analysis already run after the first Telegram acceptance.
- CAPTCHA/403/429 of one source does not stop OLX or the global worker.

### What should not be changed now

- Do not fetch three OLX pages in parallel for realtime. Page 1 is the newest-first critical surface; speculative pages add request pressure and increase 403/429/CAPTCHA risk without evidence of faster fresh discovery.
- Do not add ETag blindly. A `304 Not Modified` is useful only if OLX supplies stable validators and does not weaken freshness; no such production evidence exists yet.
- Do not move parsing to `worker_threads` yet. Event-loop utilization is low, and the old metric mixed body download with parsing.
- Do not place Telegram network I/O inside a database transaction. Prisma explicitly recommends keeping transactions short and avoiding network requests inside them because long transactions harm performance and can cause deadlocks ([Prisma transactions](https://www.prisma.io/docs/orm/v6/prisma-client/queries/transactions)).
- Do not replace the durable Telegram lease with an optimistic send. Telegram does not provide a documented idempotency key for `sendMessage`; weakening the lease would trade a few local milliseconds for duplicate-notification risk.

## Go / C# / Python decision

### Go collector/scheduler

Current verdict: **reject the rewrite**.

Go has excellent built-in CPU, memory, trace and contention profiling facilities ([Go diagnostics](https://go.dev/doc/diagnostics)), and its runtime gives explicit control over GC trade-offs ([Go GC guide](https://go.dev/doc/gc-guide)). Those are benefits, not proof that this workload is CPU-bound. Production evidence shows the opposite:

- active hot-worker event-loop utilization: 4.12%;
- network/header wait p50: 1.784 s;
- combined body-transfer/parse/candidate stage p50: 1.135 s;
- local DB subpath after optimization: p50 1.97 ms in isolation;
- the dominant source-timestamp gap is measured in minutes.

A Go rewrite may reduce resident memory, but it is unlikely to materially improve publication-to-notification latency and would introduce a second runtime, duplicated normalization semantics, cross-language contracts and a larger rollback surface. Reconsider only if the new telemetry shows sustained `bodyReceived → parsed` p95 above 250 ms or hot-worker event-loop utilization above 70% under representative traffic. Then build a sidecar canary against captured, non-secret responses and require statistically better p95/p99 with identical extracted IDs before adoption.

### C# and Python

- C# offers no demonstrated advantage for this I/O-bound path on the current machine.
- Python is appropriate for offline analytics/OCR experiments, not the latency-critical collector.
- Neither should enter the production hot path without the same side-by-side benchmark and parity gate.

## Correctness and failure testing

The isolated acceptance test passed with real PostgreSQL 18.6 and Redis 8.8.0. It verified:

- one HTTP request per deterministic OLX fixture;
- exactly one Telegram delivery for each successful fixture;
- failed Telegram request → durable retry → one final delivery;
- Redis loss after journaling → recoverable observation;
- PostgreSQL loss before and after journaling → deterministic recovery state;
- PostgreSQL loss after Telegram acceptance → recoverable lease/receipt state;
- unprovable OLX boundary remains durable `UNRESOLVED`;
- database reset/retention trigger preserves a real favorite and serializes cleanup;
- new HTTP/body/parse/journal/Telegram timestamps are monotonic.

All 81 unit/integration test files passed (397 tests), and workspace type checking passed before this report.

## Remaining risks and acceptance gates

The candidate was deployed on the HP at `2026-09-09T12:04:57Z` after creating encrypted backup `.runtime/backups/database-20260909-150411.ambbak`. Migration `20260909_hot_path_stage_timestamps` applied successfully. The first eight completed OLX realtime runs were all successful: duration p50 2,251 ms and p95/p99 3,444 ms, with zero challenge/rate-limit/access-denied responses and empty queues. This is encouraging but far below the sample needed for a production latency conclusion.

1. No new OLX candidate appeared in the initial post-deployment window, so fresh body/parse and full Telegram stage percentiles do not yet exist. The isolated end-to-end test proves the code path, but the live production AFTER cohort still needs to accumulate naturally.
2. The production publication timestamp can be coarse or delayed by OLX, so it must not be presented as pure scanner latency.
3. The 20-second configured OLX interval plus 4-second jitter is currently conservative. A previous 15-second canary regressed p95; do not retry until the split HTTP/parse metrics and challenge counters are stable.
4. RST remains externally challenged and must stay isolated. No CAPTCHA-solving or protection bypass belongs in this project.
5. AUTO.RIA and AutoMoto are limited by timestamp/source semantics, not by the OLX critical path.

Deployment acceptance requires a fresh production cohort with:

- no increase in OLX challenge/403/429 rate;
- zero failed/retry backlog;
- no duplicate Telegram delivery;
- p95 request-start → Telegram acceptance no worse than the baseline 5.494 s;
- p95 durable-journal → Telegram acceptance no worse than the baseline 1.923 s;
- new body and parse stage counts large enough to identify the actual bottleneck.

If either latency gate regresses materially or correctness fails, stop the candidate version and restore `pre-hotpath-audit-20260909`.
