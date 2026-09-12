# Auto Monitor Bot: provable completeness and evidence-qualified latency

Date: 2026-09-12

Rollback anchor: immutable tag `pre-hotpath-audit-20260909`
Upgrade baseline: `52db3e5` (`main == origin/main` before this work)

## A. Architecture Fit Report

The detailed pre-code decision record is [ARCHITECTURE_FIT_REPORT_2026-09-12.md](./ARCHITECTURE_FIT_REPORT_2026-09-12.md).

| Decision | Result |
| --- | --- |
| KEEP | PostgreSQL observation before Redis coordination; one-page realtime; separate recovery/background lanes; OLX origin coordinator; global Telegram gate; flash bundle; durable `PENDING/VERIFIED/UNRESOLVED`. |
| EXTEND | Executable outcome contract, consistency audit, deterministic ground truth, crash matrix, per-shard proof, parity attribution, initial-sync projection, T1–T7 telemetry. |
| REFACTOR | Persist the complete normalized collector burst before processing its first item; reuse the returned upsert state; extract the recovery transition decision for direct state-machine tests. |
| REJECT | Rewrite, Redis-as-truth, parallel OLX pages, protection bypass/retry storm, Telegram parallelism, new competing parity store, Go/C#/worker threads without a CPU proof, cadence reduction during P0. |

PostgreSQL `INSERT ... ON CONFLICT` is the right retained-observation primitive: PostgreSQL documents an atomic insert-or-update outcome under Read Committed for each proposed row.[^1] The recovery writer additionally locks the authoritative state row with `SELECT ... FOR UPDATE`; the integration test proves two concurrent stale snapshots accumulate rather than overwrite evidence. BullMQ job IDs remain ephemeral coordination because a removed job no longer blocks reuse of its ID.[^2] Durable pending state, not a Redis key, is therefore the last-signal guarantee.

## B. Files changed

| File | Purpose |
| --- | --- |
| `docs/ARCHITECTURE_FIT_REPORT_2026-09-12.md` | Mandatory audit-first KEEP/EXTEND/REFACTOR/REJECT decision record. |
| `apps/worker/src/modules/completeness-contract.ts` | Formal terminal/recoverable/impossible classifier. |
| `apps/worker/src/maintenance/completeness-check-cli.ts` | Read-only SQL consistency checker; rejects `--apply`. |
| `apps/worker/src/modules/observation-journal.ts` | Returns durable upsert state for every batch identity. |
| `apps/worker/src/processors/collector-run-helpers.ts` | Journals an entire normalized burst before any item processing and reuses durable state. |
| `apps/worker/src/processors/listing-detected.ts` | Accepts already-persisted observation state and avoids a redundant read. |
| `apps/worker/src/modules/source-search-plan.ts` | Explicit evidence-gated recovery transition; retains transactional row lock. |
| `apps/worker/src/modules/olx-parity-policy.ts` | Pure protection-aware parity preflight. |
| `apps/worker/src/maintenance/olx-parity-cli.ts` | Refuses traffic during protection and compares control IDs with durable observations/channel provenance. |
| `apps/worker/src/maintenance/hot-path-audit-cli.ts` | Emits full raw and evidence-qualified T1–T7 reports. |
| `apps/api/src/lib/observation-activation.ts` | Derives initial-sync semantics without schema duplication. |
| `apps/api/src/routes/observations.ts` | Exposes derived activation class. |
| `apps/api/src/routes/search-plan.ts` | Correct global recovery aggregation and per-shard coverage proof. |
| `apps/api/src/routes/system-metrics-route.ts` | OLX 24h hot-path, pressure, protection, cadence, and evidence readiness projection. |
| `apps/dashboard/app/planner/page.tsx` | Per-shard coverage evidence and truthful global proof; remains compatible during a rolling API/Dashboard upgrade. |
| `apps/dashboard/app/page.tsx` | Dedicated OLX Hot Path table and pressure state; remains compatible with the previous live API shape during rollout. |
| `packages/shared/src/utils/metrics.ts` | Direct T1–T7/internal stages, 5/30/100 percentile qualification, regression decision. |
| `packages/shared/src/types/dashboard-api.ts` | Shared API/Dashboard contracts for proof and hot-path telemetry. |
| `apps/worker/package.json`, `package.json` | Register `completeness:check`. |
| `vitest.config.ts` | Raise `collector-run.ts` meaningful coverage floor to 80/80/80/85. |
| `tests/support/deterministic-marketplace.ts` | Pre-generated mutable newest-first source and fault model. |
| `tests/provable-completeness-harness.test.ts` | Ground-truth bursts, page shifts, offset cap, partial/empty/parser/network/protection faults. |
| `tests/pipeline-crash-matrix.test.ts` | 23 precise crash/replay checkpoints and no-silent-loss assertion. |
| `tests/collector-dispatch-durability.test.ts` | Proves batch persistence precedes first inline/queue handoff. |
| `tests/collector-run-glue.test.ts` | 26 orchestrator control-flow and durable-side-effect cases. |
| `tests/source-search-plan.test.ts` | Evidence-gated state-machine transitions. |
| `tests/integration/pipeline-resilience.ts` | Real PostgreSQL/Redis/Telegram faults, DB A/B benchmark, two-writer row-lock race. |
| `tests/completeness-contract.test.ts` | Formal classification coverage. |
| `tests/olx-parity-policy.test.ts` | No-network parity protection gate. |
| `tests/observation-activation.test.ts` | Initial sync versus post-activation semantics. |
| `tests/metrics-summary.test.ts` | T1–T7, confidence exclusion, 5/30/100 thresholds, deterministic regression gate. |
| `tests/telegram-flash-policy.test.ts` | Bursts 2/5/10/20 and newest-first first-alert order. |
| `README.md`, `AUDIT.md`, `UPGRADE_PLAN.md`, `CHANGELOG.md` | Runtime, evidence, rollout, rollback, and known-risk documentation. |
| `apps/worker/src/env.ts`, `apps/worker/src/collectors/olx.ts`, `apps/worker/src/modules/olx-lane-arbiter.ts` | Remove stale “four-second” comments; no runtime setting changed. |

No dependency version, lockfile, database schema, production `.env`, cadence, cooldown, OLX concurrency, or Telegram concurrency was changed.

## C. Completeness proof

The executable contract answers: every normalized `(source, externalId)` received by the pipeline is `NOTIFIED`, `REJECTED`, `DUPLICATE`, `SHADOWED`, `RECOVERY_PENDING`, `FAILED_REPLAYABLE`, or `IMPOSSIBLE`. `IMPOSSIBLE` makes the checker fail. Compact retained `NOTIFIED` tombstones remain valid after normal card cleanup when their acceptance receipt is durable.

The deterministic source covers bursts 1/2/10/50, equal and missing timestamps, duplicates, offset-page motion, empty and partial responses, parser degradation, timeout, reset, 403, 429, CAPTCHA-like body, 500, changing page 1/page 2, recovery depth, and public offset cap. Every ID actually delivered as a normalized candidate is compared against the durable/recoverable ledger.

The crash matrix exercises 23 boundaries from HTTP body through state transaction, including callback, observation persistence, Redis claim, filter/listing/match, Telegram reservation/request/acceptance/receipt, enrichment, recovery pages, and boundary update. A complete burst is now journaled before processing item 1, so a mid-burst crash leaves a replayable tail rather than vanished memory.

The live read-only checker reported zero impossible states. Legacy Cars.ua/AutoMoto continuity anchors without observation snapshots were classified as recoverable historical evidence, not silently accepted as current normalized candidates.

## D. Coverage

Before this upgrade, the critical `collector-run.ts` gate was statements 20%, branches 40%, functions 45%, lines 20%, with measured statement coverage near 22%. After the behavioral tests it measures:

| Module | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| Global | 48.50% | 73.72% | 59.63% | 48.50% |
| `collector-run.ts` | 97.89% | 83.76% | 100% | 97.89% |
| `listing-detected.ts` | 75.57% | 91.11% | 58.33% | 75.57% |
| `observation-replay.ts` | 90.69% | 68.88% | 100% | 90.69% |
| OLX collector | 54.32% | 46.19% | 70.58% | 54.32% |
| `source-search-plan.ts` | 44.66% | 84.24% | 69.69% | 44.66% |
| first notification dispatch | 95.58% | 91.66% | 100% | 95.58% |
| Telegram service | 44.07% | 45.33% | 46.15% | 44.07% |

The new `collector-run.ts` gate is statements/lines/branches 80%, functions 85%. Lower global and collector-parser percentages reflect broad source/UI/infrastructure surfaces; the P0 critical orchestrator target is met without excluding it from the global gate.

The final full gate executed 97 test files and 528 tests successfully. It also completed Prisma validation/generation, documentation drift checks, TypeScript, ESLint, PowerShell validation, backup cryptography, CI-policy checks, coverage thresholds, and isolated API/Dashboard builds.

## E. Recovery evidence

| Scenario | Evidence |
| --- | --- |
| Short/intentional outage | Durable last success opens bounded `OFFLINE_WINDOW`; realtime resumes independently. |
| Multi-hour outage | Required cutoff is derived from the prior boundary plus safety overlap, bounded by configured lookback. |
| Realtime overflow | Opens durable `REALTIME_OVERFLOW`; deep pages run only in backfill. |
| Public offset cap | Persists `UNRESOLVED/PUBLIC_OFFSET_CAP`; automatic deep retry stops while realtime continues. |
| Parser degradation | Cannot verify coverage or advance the success boundary. |
| Two workers | Real PostgreSQL test preserves both anchors, oldest cutoff, and accumulated attempts through row locking. |
| Redis failure | Observation remains `PENDING`; replay succeeds after Redis returns. |
| PostgreSQL failure | Before journal the deterministic source remains replayable; after journal the normalized snapshot is durable. |
| Telegram ambiguity | Acceptance-before-local-receipt remains explicit and replayable; the lease delays retry to bound duplicates. |

## F. Latency

The production OLX sample for 2026-09-11 12:35 to 2026-09-12 12:35 Kyiv contains zero realtime observations because OLX is in a protection cooldown. Therefore every production T1–T7 p50/p95/p99 is **INSUFFICIENT_DATA**. No production latency claim is made.

The isolated PostgreSQL A/B benchmark used 40 alternating iterations:

| Path | SQL round trips | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: |
| Previous redundant read + broad duplicate check | 4 | 3.92 ms | 5.39 ms | 46.92 ms |
| Durable upsert state + strong duplicate only | 2 | 2.46 ms | 4.03 ms | 7.01 ms |

This proves a DB round-trip and tail reduction in the isolated environment, not a marketplace-to-user production SLO. Dashboard p50/p95/p99 require 5/30/100 samples respectively. `publishedAt` latency excludes LOW/UNKNOWN confidence.

## G. Protection and request pressure

OLX pacing/cooldowns were unchanged. No parity, speculative request, parallel page, proxy, CAPTCHA solve, fallback-after-protection, or manual cooldown reset was performed. At the final pre-deploy observation OLX was `RATE_LIMITED` after plain HTTP 403 and paused until 2026-09-13 12:27 Kyiv; RST was independently `CAPTCHA_DETECTED`. Cloudflare's documented `cf-mitigated: challenge` marker supports separating an actual challenge response from a generic 403.[^3]

The new Dashboard reports OLX requests and lane attribution over 24 hours, protection incidents per 1,000 requests, 403/429/CAPTCHA counts, and recovery pressure. Parity refuses before constructing a collector when protection or cooling is active.

## H. Known limitations

1. Without an official marketplace event stream, it is impossible to mathematically prove an advert OLX never exposed in any accessible response. The project now proves the internal fate of every normalized candidate it did receive.
2. Production p95/p99 cannot be evaluated until OLX recovers naturally and 30/100 complete accepted traces accumulate.
3. Telegram `sendMessage` has no caller-supplied idempotency key. If Telegram accepts and the process loses the response, perfect exactly-once is impossible; the durable lease intentionally prefers a rare bounded duplicate over a silent miss. Telegram's `retry_after` is propagated through the shared gate as required by the Bot API.[^4]
4. The encrypted local backup is currently on the same physical drive as production because `BACKUP_MIRROR_PATH` is not configured. Restore testing protects logical recoverability, not loss of the entire SSD.
5. Multi-category registry presence is not LIVE acceptance. New categories remain SHADOW until parser/timestamp/filter/parity/recovery/protection evidence exists per category.

## I. Final verdict

- Architecture reliability: **improved**, without a rewrite.
- Internal-miss risk: **materially reduced**; the former mid-burst memory-only tail is now durable and checked.
- CAPTCHA/rate-limit risk: **not increased**; request cadence and protection controls were unchanged.
- Intentional laptop downtime recovery: **provable within the public interface boundary** as `VERIFIED` with evidence or honestly `UNRESOLVED` with reason.
- Basis to accelerate OLX now: **no**. The current production sample is `INSUFFICIENT_DATA` and OLX is protected.
- Next reasonable experiment: only the existing controlled `20±4 → 18±3` canary after natural recovery, at least 30 complete internal traces for p95, 100 for p99, no parser/recovery/queue pressure, and zero new 403/429/CAPTCHA. Automatic rollback remains mandatory.
- Go/C#/worker threads: **not justified**. Current hot-worker event-loop utilization is below 1%; the available evidence does not identify CPU/parse as the bottleneck.

### Acceptance record

| Command | Result |
| --- | --- |
| `.\amb.cmd check:full` | PASS: 97 files / 528 tests, coverage gates and isolated builds passed. |
| `.\amb.cmd test:e2e` | PASS: 4 passed, 1 intentionally skipped mutating stop/start scenario. The rolling-upgrade compatibility defect discovered by this test was fixed. |
| `.\amb.cmd audit:prod` | PASS: no known production dependency vulnerabilities. |
| `.\amb.cmd db:restore:test` | PASS: encrypted backup restored into an isolated PostgreSQL database; 1 filter and 59 listings verified. |
| `.\amb.cmd test:recovery` | PASS under the required elevated context; API was killed and recovered with a new PID, readiness returned OK, and the existing monitoring state was preserved. |
| `.\amb.cmd test:olx-parity` | SAFE REFUSAL before network I/O because the durable OLX protection pause remains active until 2026-09-13 12:27 Kyiv. Parity evidence is therefore pending, not falsely reported as PASS. |
| `.\amb.cmd completeness:check -- --stale-hours 24 --sample-limit 10` | PASS: zero `IMPOSSIBLE`; displayed legacy continuity anchors were explicitly `RECOVERABLE`. |
| `.\amb.cmd test:pipeline:resilience` | PASS: Redis/PostgreSQL/Telegram failures, crash/replay, shadow promotion, unresolved recovery and concurrent state writers. |
| `.\amb.cmd local:status` | Runtime services and queues healthy; two hot replicas redundant; monitoring remains intentionally `STOPPED`; backup mirror remains unconfigured. |

The upgrade is not an external OLX parity certification while protection is active. Deployment must preserve the existing cooldown, and production latency remains `INSUFFICIENT_DATA` until natural recovery yields qualified samples.

## Primary sources

[^1]: PostgreSQL 18, [Transaction Isolation: Read Committed and `ON CONFLICT`](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED) and [`INSERT`](https://www.postgresql.org/docs/18/sql-insert.html).
[^2]: BullMQ, [Job IDs](https://docs.bullmq.io/guide/jobs/job-ids) and [Idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs).
[^3]: Cloudflare, [Detect a Challenge Page response](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/).
[^4]: Telegram, [Bot API response parameters](https://core.telegram.org/bots/api#responseparameters).
