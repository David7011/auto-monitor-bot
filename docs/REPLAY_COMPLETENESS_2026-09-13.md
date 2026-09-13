# Durable replay recovery — 2026-09-13

Rollback source tag: `pre-replay-completeness-20260913` (`714d777`).

## Changes

- Unfinished observations without a listing remain selectable irrespective of the historical lookback. The lookback still bounds optional reevaluation of rejected/duplicate/shadow records.
- Retention no longer deletes unfinished observations, delivery-linked records or terminal receipt tombstones.
- Replay renews its owner-token lease and releases it on bootstrap failure. STOPPED monitoring prevents scheduling and replay evaluation.
- Oldest attempts are selected first. A five-minute reservation bounds normalized replay retries; incomplete reconstruction reserves a thirty-minute retry window. Backlog reporting does not hide records merely because they are cooling down.
- OLX optional detail hydration is limited to five queued candidates per replay, and only fresh UNKNOWN candidates may request details through the elected origin owner. Proven matches use their saved snapshot.
- Serialized BullMQ dates are deserialized before evaluation. Terminal-receipt CAS prevents stale replays from reopening completed delivery.
- A permanently disconnected fail-fast producer is evicted from the queue cache so a subsequent replay can reconnect. No uncertain write is automatically retried inside enqueue.
- Pending delivery intents are periodically reconciled and scheduled independently of observation age.

## Evidence

`amb.cmd check`: 627 tests in 107 files passed, along with validation, typechecks, lint, PowerShell/crypto/backup/CI policy tests, coverage gates and isolated production build.

`amb.cmd test:pipeline:resilience` passed using isolated PostgreSQL 59072 and Redis 59073. This included a 180-day-old pending observation (`100003`) surviving retention, becoming eligible through the actual SQL selector, reaching a real BullMQ queue with serialized payload, and reaching the loopback Telegram endpoint exactly once. Repeating evaluation did not send another notification. This is acceptance evidence, not a production Telegram claim.

Other acceptance scenarios include process kill after durable outbox, database/Redis failures, partial collector HTTP 403 checkpoint, STOPPED processing and persisted origin pause across process restarts.

## Production deployment

Worker runtime deployed at 2026-09-13 18:24 UTC; API, PostgreSQL and Redis were not restarted. Runtime rollback copied into `.runtime/audit/replay-runtime-rollback-20260913-212420` before replacement.

Two fresh hot replicas (leader 6084 / standby 6396) and background worker 9328 were confirmed. Monitoring RUNNING; OLX ACTIVE, last success 18:24:38.503 UTC, one realtime HTTP request, no error. A bounded manual replay finished at 18:25:03.425 UTC with observed=0, pending=0, failed=0. All queues had zero failed/retry backlog. No new live receipt occurred in this short post-deployment window: production delivery latency cannot be inferred from the empty sample.

Protection cooling still blocks background OLX until 2026-09-14 13:05:32.011 UTC. Cadence remains 120±20 seconds. Overall worker health is WARN because other sources remain externally limited; this is not an all-sources success certification.

## Limits

This change proves recovery of saved observations, not completeness of the OLX inventory. Listings never returned by OLX during downtime cannot be promised. Unproven offset/backfill boundaries remain UNRESOLVED. Missing metadata remains actionable, not a fabricated match. Polling cadence, protection cooldown and source URLs are unchanged. No dependency upgrades or CAPTCHA bypass are included.

Owner renewal and safe token release follow [Redis distributed-lock guidance](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/). Bounded producers remain separate from resilient blocking consumers, consistent with [BullMQ connection guidance](https://docs.bullmq.io/guide/connections).
