# Zero Silent Internal Loss: follow-up audit

Date: 2026-09-12

Baseline: `d211da7` on `main`

Rollback anchor: immutable tag `pre-zero-silent-loss-followup-20260912`

## Architecture decisions

| Area | Decision | Evidence and reason |
| --- | --- | --- |
| PostgreSQL observation journal | KEEP | The complete normalized burst is persisted before Redis claim, filtering, or dispatch. PostgreSQL remains the durable source of truth. |
| Redis hot claim and BullMQ job IDs | KEEP + FIX | They remain coordination only. Recovery continuation no longer relies on one fixed active deduplication key. |
| Recovery state machine | EXTEND | Downtime, public-history cap, parser degradation, concurrent writers, and active-Recovery-A/new-Recovery-B behavior now have direct regressions. |
| Telegram reservation, lease, receipt, and global chat gate | KEEP + EXTEND | The external API has no caller idempotency key. An active ambiguous lease suppresses immediate resend; an expired lease permits one bounded fallback. |
| `CoverageRecoveryWindow` cascade | KEEP | Cleanup excludes every parent with any recovery window. A real PostgreSQL regression now proves both pending and completed evidence survive compaction. |
| OLX origin arbitration and cadence | KEEP | One origin request at a time, vehicle-first shard order, background preemption, protection cooldown, and the existing baseline/canary remain unchanged. |
| Health reporting | FIX | Operational correctness is now independent from acceleration-canary sample readiness. A durable future pause remains WARN/PROTECTED after a stop/start display-state change. |
| Go, C#, worker threads, parallel OLX pages | REJECT | No CPU/parse bottleneck has been demonstrated. These changes would add risk or request pressure without completeness evidence. |

## Defect fixed: active Recovery A could absorb Recovery B

BullMQ Simple Mode deduplication ignores a duplicate while the original job is active. The pinned BullMQ 5.81.2 runtime does not expose the newer replace/keep-last active-job behavior, and dependency versions were intentionally not changed. Recovery continuation therefore uses the durable `CoverageRecoveryWindow.attemptCount` in its `jobId`.

- Duplicate scheduling for the same durable attempt coalesces.
- An incomplete BACKFILL transaction increments the attempt number before it schedules the continuation.
- Recovery B consequently has a different ID even while Recovery A is still ACTIVE.
- Automatic retry of a failed attempt remains BullMQ's responsibility until the database transaction advances the durable attempt.
- `PUBLIC_OFFSET_CAP` still closes the automatic deep loop as `UNRESOLVED`; realtime continues.

This follows BullMQ's documented job-ID uniqueness and deduplication semantics: [Deduplication](https://docs.bullmq.io/guide/jobs/deduplication), [Job IDs](https://docs.bullmq.io/guide/jobs/job-ids).

## Added proofs

- Deterministic newest-first bursts now include 100 listings in addition to 1/2/10/50, with the existing duplicate, equal/unknown timestamp, page-shift, partial body, timeout/reset, 403, 429, CAPTCHA, 500, parser-degraded, recovery, and offset-cap cases.
- The crash matrix has 23 distinct boundaries, now explicitly including both `HTTP_RESPONSE_RECEIVED` and `NORMALIZED_CANDIDATE_CREATED`.
- Intentional downtime is tested at 5 minutes, 1 hour, and 6 hours. A gap outside the public 24-hour lookback is capped and becomes `UNRESOLVED/PUBLIC_OFFSET_CAP`, never false `VERIFIED`.
- Recovery A/B has both pure job-ID and orchestrator side-effect tests.
- Telegram tests cover pre-request failure, unresolved request ambiguity, active lease suppression, expired-lease fallback, accepted-before-local-persist, worker recovery, shared `retry_after`, and multi-worker global chat gating.
- Synthetic category load compiles 100 filters for every supported OLX category into one shard per category, keeps vehicles first, and retains all filter IDs without multiplying identical discovery requests.
- Cleanup against a real database retains `SourceSearchState` parents with both pending and completed recovery history.

## Coverage and deterministic result

The full V8 gate on this follow-up ran 98 test files and 549 tests. Relevant measured coverage:

| Module | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| Global | 48.59% | 74.05% | 59.77% | 48.59% |
| `collector-run.ts` | 97.86% | 86.17% | 100% | 97.86% |
| `listing-detected.ts` | 75.57% | 91.11% | 58.33% | 75.57% |
| `observation-replay.ts` | 90.69% | 68.88% | 100% | 90.69% |
| OLX collector | 54.32% | 46.19% | 70.58% | 54.32% |
| `source-search-plan.ts` | 44.56% | 85.71% | 69.69% | 44.56% |
| first-notification dispatch | 95.58% | 91.66% | 100% | 95.58% |
| Telegram service | 44.36% | 50.66% | 46.15% | 44.36% |

The dedicated `collector-run.ts` enforced floor remains statements/lines/branches 80% and functions 85%. Tests assert durable side effects, not only return values.

Deterministic acceptance result: every normalized ground-truth ID is either terminal or explicitly replayable/recovery-pending. `SILENT_LOSS = 0` in the modeled scenarios. This is an internal guarantee; it does not claim knowledge of listings an external marketplace never exposed.

## Performance and protection

No OLX cadence, retry, concurrency, cooldown, proxy, CAPTCHA behavior, dependency, lockfile, database schema, or production secret changed. The isolated PostgreSQL A/B path remains two SQL round trips instead of four. The follow-up 40-iteration run measured:

| Path | SQL round trips | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: |
| Legacy comparison | 4 | 3.41 ms | 4.87 ms | 45.77 ms |
| Current durable path | 2 | 2.10 ms | 4.45 ms | 6.43 ms |

This is isolated database evidence, not a production OLX-to-Telegram percentile. Production latency remains `INSUFFICIENT_DATA` while protection prevents a qualified live sample.

## Acceptance record

| Command | Result |
| --- | --- |
| `check:full` | PASS: 98 files, 549 tests, coverage and isolated production builds. |
| `test:pipeline:resilience` | PASS: real isolated PostgreSQL/Redis/Telegram faults and concurrent recovery writers. |
| `test` repeated twice after the full gate | PASS twice: 98 files and 549 tests on each run. |
| `test:e2e` | PASS: 4 browser scenarios; the explicitly mutating stop/start scenario remained safely skipped. |
| `audit:prod` | PASS: no known production dependency vulnerabilities. |
| `db:restore:test` | PASS: encrypted backup restored to an isolated database; 1 filter and 59 listings verified. |
| `completeness:check` | PASS: zero `IMPOSSIBLE`; legacy Cars.ua anchors were reported as explicit `RECOVERABLE` evidence. |
| `test:olx-parity` | SAFE REFUSAL before network I/O: durable OLX pause remains active until 2026-09-13T09:27:52.274Z. |
| `local:status` before deploy | Core OK, PostgreSQL/Redis/API healthy, two hot replicas redundant, all queues zero, monitoring RUNNING. The old live API still showed the source-pause classification defect that this release changes. |
| `test:recovery` and post-deploy status | PASS in the required elevated context: API PID `11020 → 9972`; supervisor detected it at 17:16:45 and completed targeted recovery at 17:16:53 without restarting the healthy workers or Dashboard. Core readiness returned OK, both hot replicas remained redundant, monitoring remained RUNNING, and all queues were zero. |

## Remaining limitations

1. No code can prove completeness for a listing never exposed by OLX's accessible interfaces.
2. Telegram acceptance and local persistence are separate systems; a rare bounded duplicate remains possible after an ambiguous accepted request. The design prefers that to a silent miss.
3. A production p95/p99 conclusion requires 30/100 complete live traces after natural OLX recovery.
4. OLX parity must refuse while protection is active; it cannot be honestly certified during cooldown.
5. `BACKUP_MIRROR_PATH` remains an operational single-drive risk until a different physical target is configured.
