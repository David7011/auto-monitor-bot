# Current unfinished work — 2026-09-13

This is a current checkpoint, not an assertion that every historical audit item is closed. Source rollback before this stage: `pre-resolved-cooling-20260913` (`818fe49`). User-owned untracked `work/` is preserved.

## Completed preceding this stage

- Windows OLX normal HTTPS transport restored and live collection/receipts demonstrated (`714d777`).
- Durable pending independent of lookback, retention preservation, fair replay/backoff, bounded details, serialized dates and fail-fast producer eviction (`fc056a7`). Real isolated acceptance recovered an old pending snapshot with one Telegram fixture receipt.
- Replay ownership checks during reconstruction/reservation and fail-closed Windows process management (`818fe49`). Real Redis TTL renewal and owner replacement acceptance passed. These supersede the corresponding older A08 implementation gaps, but not every A17/external completeness claim.

## Current repair

Resolved incident cooling previously ignored `recoveredAt` and retained an old pause until the next day, blocking all OLX background work despite successful realtime. Cooling now starts at confirmed recovery for RESOLVED incidents; the configured 1800-second quiet window remains. OPEN incidents, absent recovery evidence and inconsistent dates retain the old pause. No incident record, source pause, polling cadence, request budget, origin leadership or protection detector is cleared.

Validation: six new cooling tests; 46 targeted tests passed; full `amb.cmd check` passed including production build. Live release/coverage evidence must be recorded separately after deployment.

Deployment checkpoint at 18:59 UTC: the administrative launch is waiting for UAC; the deployment transcript has not started. Live workers still use the previous runtime, monitoring remains RUNNING and OLX ACTIVE. Do not mark this fix deployed until the helper completes and live evidence confirms the new gate.

## Still open, ordered

1. **Live recovery proof.** Verify bounded backfill progresses after quiet time, saved offline boundary remains durable and unreachable public offset yields UNRESOLVED rather than invented VERIFIED. Keep realtime independent; do not force repeated deep scans.
2. **Speed and end-to-end sample.** Production is STANDARD 120±20s, not LIVE 20±4s; cadence canary is disabled. Collect independent new-listing traces and compare request/header/body/parse/durable/Telegram tails before changing cadence. An empty scan or one batch cannot prove p95/p99 or publication latency.
3. **A17 full acceptance scope.** Some pre-journal/database-down scenarios prove that a deterministic fixture can be refetched, not recovery of every remote OLX advert. Ambiguous Telegram acceptance with a lost response cannot be honestly guaranteed exactly-once by local replay.
4. **RST/AUTO.RIA external limitations.** Reassess current allowed public access and parser health under existing request budgets. Do not use CAPTCHA bypass, hidden proxy retries, or mandatory API-key assumptions. RST may require an allowed data channel; software cannot promise access the source refuses.
5. **Independent backup.** Only internal volumes were detected during this stage; no attached external backup volume is available. Local encrypted backups/restore tests do not remove the single-SSD failure domain. A user-selected independent destination is required before any confidential database export.
6. **Multi-category remainder.** STRICT urgent detail lifecycle and non-car enrichment/market confidence still require dedicated acceptance; old checkpoint labels alone are not proof.
7. **Publication.** Source changes must be reviewed for secrets before a separately scoped GitHub push. Runtime artifacts and `work/` are not automatically committed.
