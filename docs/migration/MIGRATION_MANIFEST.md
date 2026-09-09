# Auto Monitor Bot migration manifest

Status: `READY_FOR_TRANSFER`
Package root: `D:\AutoMonitorMigrationPackage-20260907`

## Hardware-independent project files

- `project\git-history.bundle`: complete Git object/ref backup.
- `project\working-tree-no-secrets-20260908.7z`: authoritative tracked and untracked working tree, excluding Git metadata, secrets, databases, runtimes, dependencies and generated output. The earlier undated archive is superseded and retained only as an independent earlier copy.
- `configs-safe\`: safe environment templates, compose file and workspace manifests.
- `runtime-installers\postgresql-18.6-1-windows-x64-binaries.zip`: pinned PostgreSQL installer archive with verified upstream SHA-256.
- `database-backups\database-20260907-115629.7z`: pre-cutover encrypted logical dump plus `.sha256` and metadata sidecars.
- `secrets-encrypted\secrets-and-signing.7z`: separate AES-256 archive with encrypted headers.
- `task-scheduler\`: old task XML for audit/reference only.
- `docs\`: migration instructions and reports.
- `checksums\SHA256SUMS.txt`: package-wide hashes, excluding the checksum file itself.

## Runtime versions

| Component | Required version/source |
|---|---|
| Node.js | 24.18.0; `scripts\ensure-node-runtime.ps1` |
| pnpm | 10.34.5; `packageManager` and pinned runtime |
| PostgreSQL | 18.6; `scripts\install-postgresql-windows.ps1` |
| Redis | 8.8.0; `scripts\install-redis-windows.ps1` |
| TypeScript | 5.7.3 from lock file |
| Gradle | wrapper 9.3.1 |

Do not upgrade versions during migration.

## Package manager

pnpm only. Install with `amb.cmd install --frozen-lockfile`. Do not copy `node_modules`.

## External services

OLX, AUTO.RIA, RST, Cars.ua, Automoto.ua, Telegram, data.gov.ua, NHTSA, GitHub, Tailscale.

## Database

- Engine: PostgreSQL 18.6.
- Local endpoint: `127.0.0.1:55432`.
- Database/user names are read from `DATABASE_URL`; audited names were `auto_monitor` / `amb`.
- Backup format: `pg_dump --format=custom`, validated by `pg_restore --list`, encrypted with 7-Zip AES-256.
- Data restore must use the logical dump, never the copied live `pgdata` files.

## Redis

- Redis 8.8.0 at `127.0.0.1:6380`.
- BullMQ queues are runtime coordination state; PostgreSQL observation journal is durable.
- Do not migrate live AOF during normal transfer. At cutover, require no waiting/delayed jobs and allow startup reconciliation to rebuild runtime jobs.

## Docker

Compose exists but is not used by the current production runtime. No Docker data backup is required.

## WSL

Not installed and not required.

## Windows services

No project Windows service. Global PostgreSQL/Redis services are not dependencies of this project deployment.

## Task Scheduler

Four SYSTEM tasks: supervisor, watchdog, database backup and restore drill. Regenerate with `amb.cmd autostart:install` after `amb.cmd security:harden` and `amb.cmd security:check` on the new laptop.

## Environment variables

The full non-secret schema is `.env.example`. The transferred `.env` contains 103 distinct configured names at audit time. Do not copy the old global PATH. Project-relevant machine variables are optional `PROJECT_ROOT`, `POSTGRES_BIN`, `POSTGRES_DATA` and `REDIS_PATH`; none is required when project-local runtimes are installed.

## Secrets required

`AUTO_RIA_API_KEY`, `BACKUP_ENCRYPTION_PASSWORD`, `DASHBOARD_AUTH_SECRET`, `DATABASE_URL`, `LOCAL_API_TOKEN`, `REDIS_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

The encryption password must be stored separately from the archive before retiring the old laptop. Never commit the decrypted `.env`, signing environment, or Android keystore.

## IDE requirements

No IDE is required. Git plus PowerShell are sufficient. VS Code may be installed fresh; no verified extension set is mandatory.

## Ports used

| Port | Binding/purpose |
|---|---|
| 3001 | dashboard; localhost and private Tailscale address |
| 4000 | local API |
| 55432 | local PostgreSQL |
| 6380 | local Redis |

Do not disable Windows Firewall. Tailscale is the intended remote-access boundary.

## Startup sequence

`amb.cmd local:start` starts PostgreSQL, Redis, applies Prisma migrations, validates/builds artifacts, then starts API, two hot workers, one background worker and dashboard. Scheduled production uses supervisor/watchdog around the same lifecycle.

## Shutdown sequence

- Application only: `amb.cmd local:stop`.
- Application plus project-local PostgreSQL/Redis: `powershell -File scripts\stop.ps1 -All`.
- For cutover, disable the old scheduled tasks first, then stop all and confirm ports/processes are gone.

## Health checks

- `amb.cmd local:status`
- `amb.cmd security:check`
- `amb.cmd db:validate`
- `amb.cmd check`
- `amb.cmd acceptance:extended`
- API health is also included in `local:status`, using the configured local token where required.
