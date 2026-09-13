# Crash/recovery acceptance — 2026-09-13

Rollback tag before test upgrades: `pre-crash-recovery-acceptance-20260913` (`e4217c0`). This stage changes the acceptance suite and its isolated runner, not production code, dependencies, migrations or cadence. User-owned `work/` is preserved.

Run: `amb.cmd test:pipeline:resilience`.

## Coverage matrix

| Scenario | Mechanism | Required evidence |
| --- | --- | --- |
| Process dies before journal | Child fetches 100011; parent forcibly terminates it at checkpoint | No saved observation/notification before crash; fresh child refetches once and delivers once |
| Process dies after journal | Child durably saves 100012; parent forcibly terminates it | Fresh replay handler selects saved snapshot; real BullMQ consumer processes it; no second source fetch; one delivery |
| Process dies after listing/outbox commit | Real child killed before Telegram, 100008 | STARTUP replay schedules existing delivery intent; real consumer confirms notification once |
| Database unavailable before journal | Real PostgreSQL stopped; child must fail, 100002 | Fresh process performs permitted source refetch after recovery and delivers once |
| Database unavailable after journal | Real PostgreSQL stopped; child processing fails, 100003 | Durable snapshot survives; old-pending replay restores delivery |
| PostgreSQL engine crashes | Durability settings ON; isolated `pg_ctl stop -m immediate` | WAL recovery preserves the committed pending row unchanged |
| Redis producer disappears | Actual Redis shutdown after observation persistence, 100006 | Prompt failure; saved snapshot remains; producer/replay can hand off subsequent work after restart |
| Telegram HTTP failure | Loopback Telegram returns 503, 100004 | Retry intent/fallback survives; recovery confirms one acceptance |
| Telegram accepts then database disappears | Loopback acceptance followed by PostgreSQL stop, 100005 | Explicit AMBIGUOUS_EXTERNAL_ACCEPTANCE; no fabricated durable receipt or exactly-once claim |
| Partial batch followed by HTTP 403 | Actual collector handler and loopback response, 100009 | Journal survives; continuity boundary does not advance; replay/delivery confirms once without refetch |
| STOPPED monitoring | Actual handler, 100010 | Snapshot retained; no send while STOPPED; later RUNNING recovery confirms once |
| Replay exceeds lease TTL | SQL selector delayed past 450ms against real Redis | Lease renews; token replacement fences old owner; old release cannot remove successor |
| Stale evaluator after NOTIFIED | Fresh child evaluates/mutates 100001 | Atomic CAS returns false; entire durable row unchanged; no second Telegram acceptance |
| Old pending plus retention | 180-day pending observation, 100003 | Retention preserves it; actual SQL selection and serialized BullMQ payload reach notification once |
| Persisted origin pause | Fresh elected hot/background processes | No HTTP under pause/non-ownership; one permitted realtime probe after expiration |
| Recovery continuity/category races | Actual PostgreSQL row locking/state transitions | UNRESOLVED persists; foreign-shard/degraded evidence cannot prove cutoff; concurrent anchors are retained |

## Runner safety and evidence

Fault injection refuses execution without the integration flag, synthetic Telegram token, loopback test database/user and PostgreSQL data directory canonically inside the owned isolated runtime root. Production is never a fault-injection target.

The runner now uses `fsync=on`, `synchronous_commit=on`, `full_page_writes=on`. Earlier disabled-durability runs are not evidence of crash-durable WAL. These settings and immediate-stop recovery follow [PostgreSQL WAL documentation](https://www.postgresql.org/docs/18/runtime-config-wal.html) and [pg_ctl shutdown modes](https://www.postgresql.org/docs/18/app-pg-ctl.html).

Each new run saves a JSON result and synthetic progress/PostgreSQL/initdb diagnostics into `.runtime/audit/pipeline-<run-id>/`, outside the subsequently deleted test cluster. No dotenv, production dumps, keystore, live pgdata or Redis state is exported.

The result enumerates every expected fixture ID and checks terminal delivery or a genuinely selectable/queued/bounded retry owner. The ambiguous Telegram case is separately labelled rather than hidden behind a generic PASS.

## Limits

- This is software/process/database recovery acceptance, not physical power-cut, SSD failure, Windows reboot or production SYSTEM-autostart certification.
- A listing lost before durable commit can be recovered only if the permitted external source still returns it. The deterministic loopback fixture does not prove OLX retains every remote listing.
- Telegram accepting a message while the response/durable receipt is lost cannot be proved exactly-once by these local tests. Case 100005 intentionally remains ambiguous and is not force-retried to manufacture a terminal receipt.
- No live production latency/challenge-rate or complete OLX inventory guarantee follows from loopback acceptance.

## Run results

Preliminary extended runs passed on isolated PostgreSQL/Redis 60374/60375 and 60638/60639. The second run confirmed one loopback acceptance per all twelve fixture IDs; 100005 remained explicitly ambiguous in the database while the eleven unambiguous cases were NOTIFIED. Final durability-enabled result is recorded after execution below.

Final run: **PASS**, isolated PostgreSQL 60918 / Redis 60919, 22 checks, 12 fixture IDs. Eleven unambiguous cases ended NOTIFIED, each with one acceptance. Case 100005 had one fixture acceptance but no durable acknowledgement and remained explicitly AMBIGUOUS_EXTERNAL_ACCEPTANCE. No duplicates occurred in the exercised unambiguous paths; no broad exactly-once guarantee is inferred.

Persisted evidence: `.runtime/audit/pipeline-20260913224230-60c724/result.json`, `progress.log`, `postgres.log`, `initdb.log`. PostgreSQL diagnostics contain interrupted startup and redo evidence; committed pending snapshot equality was asserted after immediate crash recovery.

Post-run production inspection: monitoring RUNNING, hot replicas REDUNDANT (two live replicas), all queues failed=0 and delayed=0. Fault injection did not stop production services.

Final `amb.cmd check`: PASS, 634 tests in 108 files, coverage gates, schema/type/lint/security/PowerShell/crypto/backup/CI checks and isolated production build. Live build artifacts were not replaced by this test stage.
