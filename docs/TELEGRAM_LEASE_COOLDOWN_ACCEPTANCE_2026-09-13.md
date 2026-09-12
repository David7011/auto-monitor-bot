# Stage 1: Telegram lease and cross-process cooldown

Baseline/rollback revision: `059a86ca51975f12855ff4493cace628217eb6ac`.

## Scope

No OLX cadence/request-pressure/protection, filter, completeness/recovery-state-machine, database-schema, dependency, production secret or send-interval changes. Global priority redesign and independent backup are separate later stages.

## BEFORE / AFTER evidence

Before the fix, newly added regressions failed in three cases: stale card sender after gate-time ownership takeover; same case for flash; and a waiting sender ignoring another process's new cooldown (fake time start 2100 instead of at least 6000).

After: all three pass. Fake-clock keeper acceptance covers a 120-second wait under the unchanged 60-second lease, renewal ownership loss/database outage and non-overlapping renewals/timer cleanup. Additional gate tests cover Redis failure after sleep and non-shortening cooldown.

The real Redis acceptance uses three independent clients and an owned random test key, with no Telegram traffic. Measured first run: start gaps 243/267ms for a 250ms test interval (15ms scheduling tolerance), shared 400ms cooldown observed 404ms; cooldown extended while already waiting to 600ms observed 605ms. These are coordination acceptance timings, not new OLX end-to-end production benchmarks. No speedup percentage is claimed.

## Implementation

- Shared Lua admits only when Redis TIME reaches the current deadline; waiting never advances/reserves the future timeline. A waiter sleeps, reselects local priorities and rechecks atomically. Healthy admission still takes one EVAL; contended admissions may require additional EVALs.
- Watchdog follows the same Lua/wait/recheck loop and namespace. Its existing emergency-alert behavior on Redis unavailability is unchanged; ordinary API/worker paths remain fail-closed.
- Card and flash attempts use the existing monotonic attemptCount for reservation CAS, renewal and losing-owner failure-state CAS. No owner-token schema migration or reused error field is needed.
- A bounded per-attempt heartbeat renews every 15 seconds while gate/HTTP/projection work is pending. Renewal requires the same attempt, PROCESSING, no receipt and an unexpired lease. It cannot resurrect an expired lease.
- A fresh fenced renewal is required just before HTTP send. Failure/ownership loss prevents a new send; losing attempts cannot reopen another attempt's processing state. Finally clears the heartbeat, and renewal calls do not overlap.
- Normal first-send path adds one short conditional DB update before HTTP; delayed attempts add one update per 15 seconds. This safety cost is deliberate; it is not claimed to improve healthy per-advert latency.

No SQL transaction spans gate sleep or network I/O. Receipt remains committed before local journal/status projections; already accepted messages replay projections without resending.

## Remaining proof boundary

Telegram sendMessage has no caller idempotency key. Remote acceptance followed by a lost response or crash before durable receipt remains ambiguous; a later bounded retry may duplicate. A lease cannot solve this mathematically. The new fencing prevents an obsolete owner from starting after detected takeover, but does not retract an HTTP request already accepted/in flight or prevent every consequence of a very long process pause.

Rate spacing is coordinated at Redis admission. Dispatch after admission still has DB/network/event-loop scheduling; no claim of nanosecond-perfect HTTP start spacing is made. Strict cross-process realtime priority is not added here.

## Sources

- [Telegram response parameters / retry_after](https://core.telegram.org/bots/api#responseparameters).
- [PostgreSQL UPDATE and RETURNING semantics](https://www.postgresql.org/docs/18/sql-update.html).
- [Redis distributed lock validity and owner-bound extension](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/).

## Final gate

| Command | Result |
| --- | --- |
| test (first AFTER pass) | PASS: 100 files / 564 tests; two further gate regressions subsequently included in full coverage gate |
| typecheck | PASS |
| lint | PASS |
| test:powershell | PASS |
| test:telegram-global-gate | PASS: three actual Redis clients, shared and late-extended cooldown |
| test:pipeline:resilience | PASS: isolated PostgreSQL/Redis crash/replay, fake Telegram HTTP, migrations and cleanup |
| check:full | PASS: 100 files / 566 tests, coverage/policy/crypto/backup-health gates and isolated production builds |
| audit:prod | PASS: no reported production vulnerabilities |
| docs:check | PASS after final README change |
| local:status | Services and SYSTEM supervisor remain available; business monitoring STOPPED and OLX protection not bypassed |

Lease helper coverage 100/100/100/100; collector 97.86/86.17/100/97.86 unchanged. Shared send gate coverage 100 statements/lines/functions, 75 branches; no coverage threshold weakened.

The crash acceptance still uses its existing accelerated storage settings; it proves pipeline logic, not power-loss durability. No production Telegram notification or live OLX latency benchmark was attempted.

## Changed files

- apps/worker/src/modules/telegram-send-lease.ts: reusable owner-bound, non-overlapping heartbeat and pre-send assertion.
- apps/worker/src/modules/telegram-service.ts: apply lease/fenced attempt semantics to card and flash; protect losing-owner error updates.
- packages/shared/src/utils/telegram-send-gate.ts: current-time admission/recheck rather than future reservations.
- scripts/watchdog.ps1: align its gate wait with the shared protocol, retain existing emergency fallback.
- tests/telegram-send-lease.test.ts: fake-clock long wait, renewal loss/outage and cleanup tests.
- tests/telegram-acceptance-persistence.test.ts: ownership takeover regressions for card/flash plus stronger stateful CAS mock.
- tests/telegram-send-gate.test.ts: late-defer/outage/non-shortening regressions and admission-accurate fake Redis.
- tests/watchdog-telegram-rate-gate.test.ts: protect PowerShell admission/recheck protocol.
- apps/worker/src/maintenance/telegram-rate-gate-acceptance.ts: late-defer acceptance against real independent Redis clients.
- README.md, CHANGELOG.md and this document: protocol, evidence, scope and limitations.

## Deployment truth

After explicit owner approval, deployed application commit `25d0d86bfe84f6eaf20d8906187688916c9b3e77` via `amb.cmd local:restart` and the normal Windows UAC lifecycle helper. A fresh encrypted safety backup was created first: database-20260913-012201.ambbak. Pre-restart queues were empty.

The real deployment rebuilt shared/services/dashboard artifacts before the new processes started around 2026-09-12T22:23:01Z. Compiled worker contains the lease keeper/fenced attempt checks, shared gate contains current-time admission v2. New PIDs: API 19116, Dashboard 6972, background 15352, hot-a 18524 (standby), hot-b 8668 (leader); SYSTEM supervisor PID 13628 with fresh heartbeat. All four task definitions remain valid, supervisor Running, watchdog/backup/restore tasks Ready.

Post-restart local:status passed: API/PostgreSQL/Redis and worker readiness available; queues show zero waiting/active/delayed/failed backlog. Business monitoring remains STOPPED, last tick unchanged at 2026-09-12T21:45:20.325Z. OLX pause remains 2026-09-13T09:27:52.274Z; RST pause remains 2026-09-18T08:30:53.395Z. No protection bypass or production monitoring start occurred.

Post-deploy security:check PASS. Actual Redis admission acceptance PASS again: gaps 255/267ms for the 250ms test interval, shared cooldown 416ms for 400ms, already-waiting extended cooldown 616ms for 600ms. Read-only completeness checker still ok=true, impossibleCount=0, recoverableCount=50 at sampleLimit=50 (legacy anchor sample, not total count). Independent backup is still not configured: backup WARN; this separate operational risk is not falsely closed.

This proves deployment/readiness/coordination acceptance, not a new live OLX/Telegram publication-to-delivery E2E under STOPPED monitoring. Rollback tag remains pre-telegram-lease-cooldown-20260913 at the baseline commit. A later documentation-only acceptance commit does not alter the loaded application revision.
