# Set up the HP ProBook 445 G9

This procedure does not clone Windows and does not modify the old laptop. Keep the old monitor running until the explicit cutover step.

## 1. Transfer and verify

1. Copy the complete `AutoMonitorMigrationPackage-20260907` directory to the HP using an external drive or trusted local transfer.
2. Copy `BACKUP_ENCRYPTION_PASSWORD` separately through a password manager or another protected channel. Do not store it beside the package in plain text.
3. In PowerShell, verify every package hash:

```powershell
Set-Location 'X:\AutoMonitorMigrationPackage-20260907'
$fail = 0
Get-Content '.\checksums\SHA256SUMS.txt' | ForEach-Object {
  if ($_ -notmatch '^([0-9a-f]{64})  (.+)$') { return }
  $expected = $Matches[1]
  $path = Join-Path (Get-Location) $Matches[2]
  if (!(Test-Path -LiteralPath $path) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { $fail++ }
}
if ($fail) { throw "$fail package files failed SHA-256 validation" }
```

Do not continue if any hash differs.

## 2. Install minimal prerequisites

Install only:

- Git for Windows;
- 7-Zip in `C:\Program Files\7-Zip`;
- Tailscale, if private remote dashboard access is needed.

Node, pnpm, PostgreSQL and Redis are provisioned by project scripts. Docker and WSL are not required for the current production architecture.

## 3. Reconstruct source and Git history

Create `D:\auto-monitor-bot` from the complete Git bundle, then overlay the working-tree archive:

```powershell
git clone 'X:\AutoMonitorMigrationPackage-20260907\project\git-history.bundle' 'D:\auto-monitor-bot'
Set-Location 'D:\auto-monitor-bot'
git remote set-url origin 'https://github.com/David7011/auto-monitor-bot.git'
& 'C:\Program Files\7-Zip\7z.exe' x -y '-oD:\auto-monitor-bot' 'X:\AutoMonitorMigrationPackage-20260907\project\working-tree-no-secrets-20260908.7z'
git status --short
git rev-parse HEAD
```

Expected revision is `bfd0a1abbd8a118f7f88234273a2686327fed28b`, plus the preserved dirty working tree. Do not clean or reset it.

## 4. Restore secrets separately

Extract the protected archive into the project root. Enter the password interactively; never paste it into chat or a committed script.

```powershell
& 'C:\Program Files\7-Zip\7z.exe' x -y '-oD:\auto-monitor-bot' 'X:\AutoMonitorMigrationPackage-20260907\secrets-encrypted\secrets-and-signing.7z'
```

Confirm only presence, not content: `.env`, optional `apps\mobile-android\.signing.env`, and `.runtime\android-signing\auto-monitor-release.jks`.

## 5. Provision pinned runtimes and dependencies

Run the non-privileged, idempotent preparation script:

```powershell
Set-Location 'D:\auto-monitor-bot'
powershell -NoProfile -ExecutionPolicy Bypass -File '.\scripts\prepare-new-pc.ps1' `
  -WithPostgres `
  -PostgresArchive 'X:\AutoMonitorMigrationPackage-20260907\runtime-installers\postgresql-18.6-1-windows-x64-binaries.zip' `
  -WithRedis `
  -WithDependencies
```

This does not start monitoring, restore production data or register scheduled tasks.

## 6. Restore PostgreSQL without starting production

The current project restore helper is a drill against an already running server, so the first production restore remains an explicit controlled step:

1. Initialize `.runtime\pgdata` with `.runtime\postgresql\bin\initdb.exe`, using the user/password from `DATABASE_URL` without printing them.
2. Start the local server on `127.0.0.1:55432`.
3. Create the empty database named in `DATABASE_URL`.
4. Extract the encrypted `.7z` database backup to a temporary directory.
5. Validate the dump using `pg_restore --list`.
6. Restore using `pg_restore --no-owner --no-privileges --exit-on-error`.
7. Run `amb.cmd db:validate` and `amb.cmd db:migrate:deploy`.

This stage is intentionally manual until the HP is available because it handles database credentials and must refuse to overwrite any unexpected existing database. Use the pre-cutover backup only for a dry run; use the fresh final backup for production cutover.

## 7. Safe test mode

Before production cutover, keep the old laptop as the only producer. On the HP:

- do not install autostart yet;
- do not run `local:start` with live production filters;
- run `amb.cmd check`, `amb.cmd check:full`, and isolated database restore validation;
- compare results in `OLD_VS_NEW.md`.

## 8. Production cutover

Follow `RUNBOOK.md` exactly: stop/disable old, take a fresh final backup, restore it on HP, confirm old is stopped, then start HP. Never run both producers simultaneously.

## 9. Install autostart only after successful manual E2E

From an elevated PowerShell window on the HP:

```powershell
Set-Location 'D:\auto-monitor-bot'
.\amb.cmd security:harden
.\amb.cmd security:check
.\amb.cmd autostart:install
.\amb.cmd security:check
```

Run the task once, then verify `amb.cmd local:status`. Do not import the old XML blindly because it embeds the old path and old machine metadata.
