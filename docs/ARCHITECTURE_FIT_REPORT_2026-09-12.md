# Architecture Fit Report: provable completeness before latency

## Executive decision

The current architecture should be strengthened, not replaced. Its most important invariant is already correct: a normalized candidate is upserted into PostgreSQL before any Redis-only coordination can suppress parallel work. OLX realtime, recovery/coverage, enrichment, and Telegram delivery are also already separated into distinct lanes. The P0 work therefore focuses on executable proof, state consistency, queue edge cases, and critical-orchestrator coverage. No cadence, OLX request pressure, production protection state, or Telegram concurrency should change during P0.

## Fit matrix

| Proposed change | Decision | Evidence and implementation boundary |
| --- | --- | --- |
| PostgreSQL observation before Redis claim | **KEEP** | `listing-detected.ts` persists unless `observationPersisted`; queued dispatch in `collector-run-helpers.ts` also persists before enqueue. The `(source, externalId)` unique key makes the journal upsert-safe. PostgreSQL documents that `INSERT ... ON CONFLICT DO UPDATE` guarantees an insert-or-update outcome under Read Committed, absent unrelated errors.[^1] |
| Fast `onHotCandidates` callback | **KEEP + EXTEND** | The callback is a latency optimization and the collector still returns the same candidates for the normal path. Extend tests to prove callback failure, post-callback failure, and replay; do not make the callback the only ownership path. |
| Formal zero-silent-loss state contract | **EXTEND** | Existing `ObservationDecision`, notification states, durable normalized snapshots, and observation replay already express terminal/recoverable outcomes. Add a pure classifier plus read-only consistency checker; do not add duplicate enums. |
| Destructive automatic consistency repair | **REJECT** | Diagnosis must be read-only by default. Repairs need a separately designed `--apply` operation with backups and explicit scope; P0 does not need it to prove detection. |
| Deterministic mutable-marketplace harness | **EXTEND** | Existing parser/feed tests and the PostgreSQL/Redis resilience harness cover important fragments, but there is no single pre-generated ground-truth ledger spanning pagination mutations and the requested fault matrix. Add a deterministic harness around existing contracts rather than a second collector stack. |
| `collector-run.ts` rewrite | **REJECT** | Its control flow is large but encodes correct lane/protection/state ownership. A rewrite would enlarge the failure surface. Expand dependency-controlled branch tests first; extract only a seam that is demonstrably required for deterministic fault injection. |
| `collector-run.ts` coverage gate | **REFACTOR (tests/seams only)** | The current file-specific floor (20/40/45/20) and measured statement coverage near 22% do not substantiate a critical orchestrator. Cover real branch effects, then raise the gate to the highest meaningful achieved floor. Infrastructure-only lines may justify a documented deviation from 80%, but not the current floor. |
| Recovery state machine | **EXTEND** | Durable `PENDING`, `VERIFIED`, and `UNRESOLVED` windows already exist. `coverageVerificationHasDurableEvidence` correctly prevents a current realtime overlap from proving an older pending gap. Add transactional race and re-arm transition tests; preserve `UNRESOLVED` when the public boundary cannot be reached. |
| A new competing coverage store | **REJECT** | `SourceSearchState` plus `CoverageRecoveryWindow` is already the authoritative model. Add projections/checks to it instead of another truth source. |
| Per-shard coverage proof API/dashboard | **EXTEND** | `/search-plan` already exposes much of the state, but global claims and last-audit evidence must be checked and made explicitly aggregate-aware: any active `PENDING`/`UNRESOLVED` scope prevents a global “proved complete” claim without marking realtime DOWN. |
| A second OLX parity system | **REJECT** | Extend `test:olx-parity`. It already compares public IDs to the durable journal. It must refuse network sampling during active 403/429/CAPTCHA/cooling and add channel attribution/first-durable latency. |
| Initial-sync enum/schema expansion | **REJECT unless audit disproves derivability** | Existing filter activation, search-state initial completion, observation first-seen, and notification mode timestamps should distinguish existing observations from new-after-activation. Prefer a computed projection and tests. |
| BullMQ job IDs as durable completeness | **REJECT** | BullMQ job IDs only suppress duplicates while a same-ID job remains in the queue; removed jobs no longer participate.[^2] PostgreSQL remains the source of truth. Job IDs are coordination only. |
| Queue last-signal guarantee | **EXTEND** | Realtime job IDs include generation/due time and recovery jobs include time, reducing accidental permanent suppression. Still add a deterministic ACTIVE-job/new-evidence test and, if it fails, persist a follow-up-needed marker rather than relying on Redis deduplication. BullMQ recommends idempotent, atomic jobs because retries are expected.[^3] |
| Heavy enrichment before first Telegram alert | **REJECT** | Possible-duplicate/enrichment work is already outside the critical first-send path. Moving it back would increase latency and crash surface without improving observation completeness. |
| Parallel OLX realtime pages / aggressive fallback | **REJECT** | They raise shared-origin pressure and confound protection signals. Realtime remains one bounded newest-first page; deep history belongs to resumable background recovery. |
| CAPTCHA solving, proxy rotation, cooldown reset | **REJECT** | Protection responses remain circuit inputs. Cloudflare provides an explicit challenge-response marker (`cf-mitigated: challenge`), supporting exact classification rather than broad body guesses.[^4] |
| Telegram parallel sends to beat the gate | **REJECT** | Keep the global per-chat gate and flash bundle. Telegram documents `retry_after` as the required wait after flood control.[^5] The acceptance-before-local-receipt window cannot be made mathematically exactly-once because `sendMessage` has no caller idempotency key; bounded ambiguity handling is the correct design. |
| Lower OLX cadence during P0 | **REJECT** | P0 is proof-only. A later 20±4 → 18±3 experiment is allowed only through the existing canary after adequate clean telemetry and automatic rollback. |
| Go/C#/worker threads or full rewrite | **REJECT** | Existing telemetry has not established CPU/parse as the main bottleneck. A language change cannot improve marketplace visibility or network time and would duplicate mature durability/protection logic. |

## P0 implementation order

1. Define the executable outcome classifier and read-only consistency checker, with bounded samples and nonzero exit on impossible states.
2. Add deterministic fake-marketplace ground truth and requested fault sequences; compare every delivered normalized ID with durable terminal/replayable state.
3. Complete crash/replay coverage across journal, claim, state-boundary, recovery, and Telegram reservation/receipt seams using unit tests plus the existing real PostgreSQL/Redis acceptance.
4. Expand `collector-run.ts` behavioral coverage and raise its file gate based on meaningful reachable branches.
5. Complete recovery-state race/re-arm tests, then coverage proof projection, parity attribution, initial-sync semantics, and active-job last-signal audit.
6. Run repeated P0 acceptance before any latency change. Only after P0 is green may P1 use the existing timestamps and canary; insufficient production samples must be reported as `INSUFFICIENT_DATA`.

## Non-negotiable proof boundary

The project can prove what happened to every normalized candidate it actually received. It cannot mathematically prove an advert that OLX never exposed through any accessible response without an official event stream. Therefore internal zero-silent-loss and external marketplace completeness are reported separately.

## Sources

[^1]: PostgreSQL 18, [Transaction Isolation — `ON CONFLICT` behavior under Read Committed](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED) and [`INSERT`](https://www.postgresql.org/docs/18/sql-insert.html).
[^2]: BullMQ, [Job IDs](https://docs.bullmq.io/guide/jobs/job-ids).
[^3]: BullMQ, [Idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs).
[^4]: Cloudflare, [Detect a Challenge Page response](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/).
[^5]: Telegram, [Bot API response parameters](https://core.telegram.org/bots/api#responseparameters).
