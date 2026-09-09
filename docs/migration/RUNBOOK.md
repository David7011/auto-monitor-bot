# Migration and operations runbook

## Start project

```powershell
Set-Location 'D:\auto-monitor-bot'
.\amb.cmd local:start
```

## Stop project

Application only:

```powershell
.\amb.cmd local:stop
```

Application and project-local PostgreSQL/Redis:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File '.\scripts\stop.ps1' -All
```

## Restart and status

```powershell
.\amb.cmd local:stop
.\amb.cmd local:start
.\amb.cmd local:status
```

## Logs

Logs are under `.runtime\logs`. Inspect recent `*.err.log`, supervisor, watchdog, PostgreSQL and Redis logs. Search for `ERROR`, `FATAL`, `UnhandledPromiseRejection`, `ECONNREFUSED`, `ETIMEDOUT`, `429`, `403`, database errors, Redis errors and migration errors. External rate-limit/CAPTCHA states are warnings to preserve, not reasons to bypass protection.

## Redis and queues

Use `amb.cmd local:status`; it reports Redis reachability and per-queue waiting, active, delayed, prioritized and failed counts. Do not run `FLUSHDB` or `FLUSHALL`.

## PostgreSQL

```powershell
.\amb.cmd db:validate
.\amb.cmd db:migrate:deploy
.\amb.cmd db:backup
.\amb.cmd db:restore:test
```

The backup and restore drill require 7-Zip and the project-local PostgreSQL tools.

## Safe cutover checklist

1. On HP, complete source/secrets/runtime/dependency installation and isolated checks without enabling production autostart.
2. Record old queue counts. Wait for `waiting=0`, `delayed=0`, and no long-running backfill/coverage work. A short realtime collector may finish naturally.
3. Disable all four old scheduled tasks so watchdog cannot restart the old monitor.
4. Run old `scripts\stop.ps1 -All` and confirm ports 3001, 4000, 55432 and 6380 are no longer owned by the project.
5. Create a fresh forced database backup on the old laptop and copy its `.7z`, `.sha256`, and `.json` sidecars to the HP. Verify SHA-256 after transfer.
6. Restore that final database on HP. Do not copy live `pgdata` or Redis AOF.
7. Confirm the old laptop is still stopped.
8. Start HP once manually. Check status, database, Redis, both hot workers, background worker and queue counts.
9. Run a controlled end-to-end item path: collector -> observation journal -> queue -> worker -> database -> Telegram acceptance. Confirm one notification and no duplicate.
10. Observe at least two OLX realtime cycles plus startup catch-up/backfill progress. Confirm timestamps/timezone and persisted offline boundary.
11. Only then install HP scheduled tasks and verify a fresh task run.

## Common problems

- Port already used: identify the owning process; do not kill an unrelated service blindly.
- PostgreSQL missing: run `scripts\install-postgresql-windows.ps1` with the supplied verified archive.
- Redis missing: run `amb.cmd redis:install`.
- Dependencies differ: delete nothing; rerun `amb.cmd install --frozen-lockfile` and inspect the error.
- API 401: use `local:status`, which handles configured local authentication, rather than unauthenticated direct requests.
- Source rate-limited/CAPTCHA: preserve the protection pause; do not add aggressive retries.
- Scheduled task fails: run `security:check`, inspect task action/working directory, then execute the launcher manually from an elevated console.

## Recovery

Use `ROLLBACK.md`. The old laptop remains the rollback authority until the HP has passed full runtime and end-to-end verification.
