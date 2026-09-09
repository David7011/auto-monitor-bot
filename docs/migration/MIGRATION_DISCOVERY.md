# Auto Monitor Bot migration discovery

Audit time: 2026-09-07 (Europe/Kyiv)
Scope: old Lenovo laptop, read-only discovery plus migration artifacts
Target: HP ProBook 445 G9, not yet connected
Status: `READY_FOR_TRANSFER`

## Project locations

- Active repository: `D:\auto-monitor-bot`.
- Git remote: `https://github.com/David7011/auto-monitor-bot.git`.
- Active branch and revision: `main`, `bfd0a1abbd8a118f7f88234273a2686327fed28b`.
- Old orphan copy: `D:\apps`, `D:\packages`, `D:\package.json`, `D:\docker-compose.yml` (version 0.2.0, dated 2026-07-09). It is not a Git repository and is not used by the active runtime. Preserve it on the old laptop; do not deploy it.
- Old archive: `D:\auto-monitor-bot-clean-2026-07-27-150202.zip`. Preserve only as historical material.
- No second related Git repository was found. `D:\DevTools\flutter` is unrelated.
- WSL is not installed; no project files exist in a WSL distribution.

## Project architecture

```text
Dashboard / Android client
          |
Fastify API (127.0.0.1:4000)
          |
PostgreSQL 18.6 (127.0.0.1:55432)  <-- durable state and observation journal
          |
BullMQ queues on Redis 8.8.0 (127.0.0.1:6380)
          |
hot worker A + hot worker B + background worker
          |
OLX / AUTO.RIA / RST / Cars.ua / Automoto.ua -> Telegram
```

Repository components:

- `apps/api`: Fastify API and monitoring orchestrator.
- `apps/dashboard`: Next.js dashboard on port 3001.
- `apps/mobile-android`: Android client built with the Gradle wrapper.
- `apps/worker`: collectors, realtime/backfill/coverage workers, Telegram delivery.
- `packages/db`: Prisma schema, 38 applied migrations, generated client.
- `packages/shared`: shared types and policy utilities.
- `scripts`: pinned runtimes, start/stop/status, supervisor/watchdog, backups, restore drills, security and acceptance checks.

## Git state

- Local `HEAD` and `origin/main` are equal (`0 ahead`, `0 behind`).
- The working tree is intentionally dirty: 65 tracked files modified plus important untracked source, tests, documentation, and seven migration directories.
- `git diff --stat` at audit time: 65 files, 2,839 insertions, 362 deletions; untracked files are additional.
- No stash exists.
- A remote clone alone is insufficient. The migration source archive is authoritative for the dirty working tree; the Git bundle preserves repository history.
- Destructive Git commands were not run.

## Old laptop runtime

- Hardware reported by Windows: Lenovo 82K2, 16 GB RAM, x64.
- OS API reports Windows product name inconsistently (`Windows 10 Home`) with build `26200`; record build and architecture rather than relying on the marketing name.
- Windows timezone: `FLE Standard Time` (Kyiv-aware). PostgreSQL reports `GMT`; the application stores/compares UTC timestamps and presents Kyiv time where required.
- Git: 2.51.2.windows.1.
- Node.js: project-pinned 24.18.0.
- pnpm: project-pinned 10.34.5.
- PostgreSQL: project-local EDB Windows x64 binaries, 18.6.
- Redis: project-local Windows build, 8.8.0.
- Gradle wrapper: 9.3.1. Android SDK/JDK are project runtime dependencies and are regenerated, not copied as the migration source of truth.
- Tailscale is installed and supplies private dashboard access.
- VS Code is installed at a nonstandard old-machine path. Extension enumeration returned no verified list; editor profile is not required to run the project.

## Data and queues

- PostgreSQL database: `auto_monitor`, user `amb`, approximately 107 MB at audit time.
- Audit counts: 1 filter, 40 listings, 9,406 observations, 38 applied migrations. These values will change while monitoring remains active.
- Redis uses AOF with `appendfsync everysec`, `noeviction`, and no periodic RDB snapshots.
- Redis audit: approximately 4,685 keys and 12.36 MB in use.
- Queue audit was idle or transiently had one active realtime collector. No waiting, delayed, or prioritized work was present. Historical failures: collector.run 4, collector.coverage 2, observation.replay 1; recent failures 0.
- PostgreSQL is the durable observation journal. Do not copy live BullMQ/AOF state blindly and do not use `FLUSHDB`/`FLUSHALL`.

## Docker, WSL, services and process managers

- A compose file exists for reproducible development infrastructure, but Docker CLI/Desktop is not installed and the production runtime is native Windows.
- There are no live project containers, images, volumes, or networks to migrate.
- WSL is not installed.
- PM2/NSSM/forever are not used. Project lifecycle is handled by PowerShell supervisor/watchdog scripts.
- Separate machine-wide PostgreSQL 18 and Redis Windows services exist, but the active project uses its own runtimes and ports. Do not clone or reconfigure those unrelated services.

## Scheduled tasks

All four project tasks run as `SYSTEM`, highest privileges, with one-minute restart policy and `IgnoreNew` behavior:

| Task | Trigger | Action | Old status |
|---|---|---|---|
| Auto Monitor Bot | boot + any-user logon | `scripts\supervisor.cmd` | running; latest manual overlapping request returned `0x800710E0` while supervisor and health remained live |
| Auto Monitor Bot Watchdog | every minute | `scripts\watchdog.cmd` | last result 0 |
| Auto Monitor Bot Database Backup | daily 03:15 | `scripts\backup-database.cmd` | last result 0 |
| Auto Monitor Bot Database Restore Drill | Sunday 04:00 | `scripts\test-database-restore.cmd` | last result 0 |

Exported XML is retained for audit only because it contains the old absolute path. On the new laptop, prefer `amb.cmd autostart:install`, which generates tasks for the actual new path.

## Secrets and external integrations

Secrets were found and isolated; values were never written to this report. Required secret-bearing keys are:

`AUTO_RIA_API_KEY`, `BACKUP_ENCRYPTION_PASSWORD`, `DASHBOARD_AUTH_SECRET`, `DATABASE_URL`, `LOCAL_API_TOKEN`, `REDIS_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

Other configuration keys and safe blanks are documented in `.env.example` and `.env.windows.example`. External integrations are OLX, AUTO.RIA, RST, Cars.ua, Automoto.ua, Telegram, data.gov.ua, NHTSA, GitHub and Tailscale. Source access protections and CAPTCHA/rate-limit pauses must be preserved; migration does not bypass them.

No `%USERPROFILE%\.ssh` directory was present. Do not migrate private SSH keys. GitHub credentials should be authenticated afresh on the HP.

## Hidden machine dependencies found

- One pnpm store path was hard-coded to `D:\.pnpm-store`; it was changed to the repository-local `.runtime\pnpm-store` after the backup.
- Scheduled task XML embeds `D:\auto-monitor-bot`; regenerate tasks if the target path differs.
- Database/restore scripts expect 7-Zip at `C:\Program Files\7-Zip\7z.exe`.
- PostgreSQL fallback paths and historical documentation mention drive `D:`. The migration runbook therefore recommends `D:\auto-monitor-bot` initially for 1:1 compatibility.
- `apps/mobile-android\local.properties` is machine-specific and ignored; recreate it through Android setup.

## Sources used for migration decisions

- PostgreSQL custom dumps are portable archives intended for `pg_restore`: https://www.postgresql.org/docs/current/app-pgdump.html and https://www.postgresql.org/docs/current/app-pgrestore.html
- Redis documents AOF replay and the need to coordinate AOF backup with rewrites: https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/
- Git bundles preserve refs and objects for offline transfer: https://git-scm.com/docs/git-bundle
- Windows scheduled task definitions can be exported and registered as XML: https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/register-scheduledtask
