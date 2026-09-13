# OLX production follow-up — 2026-09-13

Initial HEAD: fc056a79467945c7c89c5710ddf8c5dc6170a689; clean main. Reviewed actual diffs of 714d777 and fc056a7, not only their messages. No fetch/pull/push.

## Findings

- 714d777 routes Windows OLX HTTPS GET through SourceHttpClient and its existing OlxRequestCoordinator. Timeout, decompressed size, response/protection classification and Retry-After remain bounded. Cancellation terminates the hidden persistent helper; a later allowed request starts another helper. No proxy/cookie/challenge bypass was added.
- The earlier same-URL Windows200 versus Node/curl403 experiment is documented in OLX_WINDOWS_TRANSPORT_2026-09-13.md. This session did not repeat rejected-client probes or add diagnostic OLX requests. Automatic production passes confirm Windows remains functional. Exact remote rule and TLS fingerprint causality remain unproven: CloudFront403 alone cannot distinguish WAF and origin rejection ([AWS](https://docs.aws.amazon.com/waf/latest/developerguide/cloudfront-waf-use-cases.html)).
- Cadence120±20 is STANDARD mode persisted by startStandardMonitoring; LIVE20±4 is a different configured mode. Native transport does not set cadence. Canary is DISABLED.
- Latest403 incident: detected2026-09-11T08:30:51Z, recovered2026-09-13T17:54:04.559Z, statusRESOLVED, persisted cooldownUntil2026-09-14T13:05:32.011Z. Background cooling uses max(detectedAt+1800s, cooldownUntil), independently of incident resolution. Hence backfill/coverage/hedge and parity remain blocked. Do not erase this evidence to speed polling.
- Retained120±20: approximately30 realtime requests/hour per current single search scope (bounded jitter100–140s); no increased pressure. Background requestCount0 while cooling. One recovery window remains PENDING; realtime known-tail metrics do not close it.

## Changes

- apps/worker/src/processors/observation-replay.ts: check renewable token ownership during incomplete snapshot reconstruction, after reconstruction/SQL reservation, and before continuing after per-item failure. Lease loss terminates the old replay instead of allowing the rest of its batch.
- tests/observation-replay-glue.test.ts: ownership stolen during reservation prevents enqueue and observation outcome mutation.
- tests/integration/pipeline-resilience.ts: actual SQL selector blocked beyond450ms lease TTL verifies real Redis renewal; replacing the owner token fences the old handler and preserves the successor. Crash/restart outbox acceptance now invokes processObservationReplay STARTUP to schedule work through the production handler instead of constructing a send job.
- A03 terminal partial checkpoint and STOPPED journal-only branches were already present. fc056a7 already removes pending age cutoff and retention loss. These behaviors were retained and exercised rather than rewritten.

## Validation and limits

check:full including unchanged coverage thresholds, typecheck/lint, schema, PowerShell/security/backup checks and isolated production build passed. E2E4 passed,1 skipped (monitoring mutation). Isolated resilience tests exercise actual process kill/restart, PostgreSQL/Redis failures, durable selector, BullMQ serialization, Telegram gate, shadow suppression and recovery state. Partial collector acceptance substitutes collect result generation using real loopback feed/protection parsing and actual production handler; it does not prove every real OLX pagination behavior. SQL/Redis replay barrier is injected; storage/lease/selector/handler are real.

Parity refused before HTTP because cooling is active; no live parity/completeness claim. No p95/p99 or long-term challenge-rate certification. Native detailed DNS/TCP/TLS telemetry is unavailable. ZERO SILENT INTERNAL LOSS is supported for tested saved-work crash scenarios, not a proof of all source inventory or ambiguous Telegram acceptance outcomes.

Live SCHEDULED REALTIME:18:30:20.229–18:30:24.509Z,18:32:07.077–18:32:09.673Z,18:33:47.431–18:33:49.869Z. Each1 request and51 observed cards, SUCCESS, no new observations/receipts. This sample proves collection continues; it provides no new request→Telegram latency sample. Historical same-pass4587ms receipts remain historical evidence only.

Runtime management finding: the non-elevated recovery acceptance could not read SYSTEM process command lines. Its fallback recovery incorrectly created user-owned replicas and rewrote PID files. The attempt was rolled back to the original replay module, only the newly created verified user workers were stopped, and original PID files restored. Supervisor returned to monitoring and core readinessOK. recover.ps1 and test-supervisor-recovery.ps1 now reject non-elevated execution before PID/process mutation. Native regression verification confirms no PID hash changes on that rejection. The initial real STARTUP acceptance also exposed missing RUNNING state in the fixture; the corrected fixture proves STOPPED retains PENDING, then RUNNING recovers via the actual handler. Final isolated resilience suite passed.

Additional live evidence before deployment:18:37:49.740–18:37:51.968Z,1 request,52 cards,SUCCESS,newCount0. Saved historical receipt934716790:request18:23:50.107Z,headers18:23:51.258Z,body18:23:51.989Z,journal18:23:52.190Z,Telegram18:23:52.373Z (2266ms); it predates this session. Production pending observations without listing count0. Full worker healthWARN is caused by other externally limited sources; OLX healthOK and hot redundancyREDUNDANT.
