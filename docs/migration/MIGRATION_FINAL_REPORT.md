# Migration final report

## 1. Project location

Active old-laptop repository: `D:\auto-monitor-bot`. Target path recommended: `D:\auto-monitor-bot` on the HP.

## 2. Architecture

TypeScript/pnpm monorepo: Next.js dashboard and Android client -> Fastify API -> PostgreSQL/Prisma durable state -> BullMQ/Redis -> redundant hot workers and background worker -> marketplace collectors and Telegram.

## 3. Git

Branch `main`, revision `bfd0a1abbd8a118f7f88234273a2686327fed28b`, GitHub remote. Origin and local commit match, but 65 tracked files plus important untracked work are not committed. Both Git bundle and working-tree archive are required.

## 4. Runtime

Node 24.18.0, pnpm 10.34.5, PostgreSQL 18.6, Redis 8.8.0, Gradle wrapper 9.3.1.

## 5. Dependencies

Restore from `pnpm-lock.yaml` using `amb.cmd install --frozen-lockfile`. Do not transfer `node_modules`, caches, builds, browser binaries or old logs.

## 6. Environment variables

Only names are recorded. Secret-bearing names: `AUTO_RIA_API_KEY`, `BACKUP_ENCRYPTION_PASSWORD`, `DASHBOARD_AUTH_SECRET`, `DATABASE_URL`, `LOCAL_API_TOKEN`, `REDIS_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Full safe schema: `.env.example`.

## 7. Databases

Local PostgreSQL `auto_monitor` at port 55432; 38 applied migrations. A validated encrypted logical backup exists. A new final dump is required only at actual cutover because the old monitor remains active.

## 8. Redis / BullMQ

Project-local Redis 8.8.0 at port 6380, AOF enabled. Runtime queue state is reconstructable from PostgreSQL durable observations. No live Redis copy will be used.

## 9. Docker

Compose is present but current production does not use Docker. No Docker volume migration is needed.

## 10. WSL

Not installed and not required.

## 11. Scheduled tasks

Four SYSTEM tasks were audited and exported. XML is reference only; regenerate tasks on HP after manual E2E and ACL validation.

## 12. Windows services

No project service. Machine-wide PostgreSQL/Redis services are separate and should not be migrated as project dependencies.

## 13. IDE

No IDE dependency. VS Code may be installed fresh; extension inventory is not verified.

## 14. External services

OLX, AUTO.RIA, RST, Cars.ua, Automoto.ua, Telegram, data.gov.ua, NHTSA, GitHub and Tailscale. Existing external protection states remain intentional.

## 15. Data backups

- Git history bundle: created and verified.
- Dirty working tree archive: `working-tree-no-secrets-20260908.7z`, created and archive-tested; the earlier undated archive is superseded but retained as an independent copy. A package audit found Android `.signing.env` and `local.properties` entries in that earlier archive; only those archive entries were removed, the working originals were untouched, and both source archives now report zero forbidden secret/machine-file entries.
- Reconstruction dry-run passed in an isolated local directory: Git bundle restored the exact expected `HEAD`; all 67 content-modified paths and all 31 untracked paths matched the active repository; required migration files were present and forbidden secret files were absent.
- PostgreSQL logical dump: created, encrypted and restore-drill validated.
- Secrets/signing archive: created separately with AES-256 encrypted headers and archive-tested.
- Old laptop data: untouched.

## 16. Migration package

`D:\AutoMonitorMigrationPackage-20260907`. It contains source, history, safe configs, PostgreSQL installer, database backup, encrypted secrets, task XML, docs and checksums. Final package audit: 27 payload files, 336.97 MiB before the checksum manifest itself.

## 17. Checksums

`checksums\SHA256SUMS.txt` contains 27 SHA-256 entries. Local re-verification reported zero mismatches. It must pass again on the HP before extraction.

## 18. Setup on new laptop

See `SETUP_NEW_PC.md`. The safe bootstrap provisions exact runtimes and lockfile dependencies but does not start production or install SYSTEM tasks.

## 19. Tests

Old runtime health is currently OK for API, PostgreSQL, Redis, both hot replicas and background worker. The post-migration-artifact `amb.cmd check` passed on 2026-09-08: security check, Prisma validation/generation, runtime-doc synchronization, typecheck, lint, 75 test files/355 tests, coverage execution and isolated production builds. Both new installer scripts passed PowerShell parsing; PostgreSQL idempotency and the no-switch bootstrap path were exercised successfully. The HP still requires its own full gate.

## 20. Functional OLX test

Old laptop: OLX active and fresh during audit. HP: `NOT VERIFIED`; production E2E is prohibited until safe cutover.

## 21. Problems found

- Git remote does not contain the dirty working tree.
- Hard-coded pnpm store path depended on drive D; corrected to project-local runtime.
- PostgreSQL had no reproducible installer script; a pinned SHA-256-checked installer was added.
- A current-tree and Git-history token-signature scan found no actual secret value. Seven current-tree heuristic matches were reviewed as safe example keys or source-code identifiers; the transfer archive independently contains no `.env`, signing environment, keystore, private-key, or local-properties entry.
- Exported task XML embeds old absolute paths.
- First combined bootstrap prototype was blocked by Defender because it combined setup with privileged SYSTEM/ACL actions. Protection was not bypassed; final preparation script is non-privileged and task installation remains a separate explicit step.
- Old main task reports `0x800710E0` for an overlapping/manual request while supervisor/runtime is healthy; verify a clean fresh task run on HP.

## 22. Differences old vs new

See `OLD_VS_NEW.md`. HP values are not yet available.

## 23. Remaining manual steps

Transfer package, verify checksums, restore source/secrets/dependencies, perform isolated DB restore, run all checks, stop old, take/restore final dump, start HP, run E2E, install tasks and complete live comparison.

## 24. Rollback procedure

See `ROLLBACK.md`. The old laptop remains intact and is the rollback authority.

## 25. HP restore status (2026-09-08)

`TRANSFERRED_NOT_VERIFIED`

The package passed SHA-256 verification on the HP. Git revision and remote were restored, pinned Node 24.18.0, pnpm 10.34.5, PostgreSQL 18.6 and Redis 8.8.0 were provisioned, dependencies were installed with `amb.cmd install --frozen-lockfile`, and the preliminary database dump was restored and migrated to 38 migrations. Typecheck, lint, 355 tests, coverage execution, production build and the isolated PostgreSQL/Redis resilience acceptance passed.

At the user's explicit request, the Android application, Android build/check scripts and generated Android artifacts were removed from the HP working tree. The laptop deployment now consists only of the API, dashboard, workers, PostgreSQL and Redis.

Not `VERIFIED`: production was not started, scheduled tasks were not installed, the old laptop remains the sole production producer, and a fresh final dump plus controlled live E2E are still required.

## 26. Controlled cutover completion (2026-09-08)

`VERIFIED`

The old producer was confirmed stopped before the HP production session began. The final archive `database-20260908-110640.7z` matched SHA-256 `9c26082ad48822caffe0591966eedac5df4da4612ecfce82be77347c70e10338`. A separate HP safety backup was created before replacement. The final logical dump was restored with `pg_restore --no-owner --no-privileges --exit-on-error`; `amb.cmd db:validate` and `amb.cmd db:migrate:deploy` passed with 38 migrations.

The HP runtime passed live checks for the API, PostgreSQL, Redis, two hot-worker replicas, the background worker, queue health, OLX realtime and persisted recovery/backfill state. A Modern Standby interruption was diagnosed from Windows Kernel-Power events, production was stopped safely, diagnostic logs were preserved under `.runtime\cutover-diagnostics\20260908-114436`, automatic sleep/hibernate was disabled, and the single stalled CARS_UA job was retried successfully. No Redis flush was used.

Live OLX-to-Telegram E2E evidence:

- OLX `934167116`, `Mitsubishi lancer 9 автомат`: first seen `2026-09-08T08:44:43.575Z`; Telegram accepted/sent `2026-09-08T08:44:46.127Z`; message ID `3791`; one notification row; attempt count 1; no error.
- OLX `934170439`, `Citroen C-Crosser`: first seen `2026-09-08T09:17:19.350Z`; Telegram accepted/sent `2026-09-08T09:17:22.535Z`; message ID `3794`; one notification row; attempt count 1; no error.

Both notifications remained unique after subsequent collector cycles. All queue failed/recent-failed counts were zero. Runtime ACL hardening and the security check passed. Four regenerated SYSTEM tasks were installed: main supervisor, watchdog, daily encrypted database backup and weekly restore drill. The main SYSTEM task was started explicitly and reached `Running`; the subsequent application health check reported API/database/Redis OK, OLX ACTIVE, two consistent hot replicas and monitoring RUNNING.
