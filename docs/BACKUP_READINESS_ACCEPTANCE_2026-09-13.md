# Backup readiness and coverage regression protection

Date: 2026-09-13 (Europe/Kyiv). Baseline: `919eac8`.

## Scope

No OLX, Telegram, journal, recovery, scheduling, cadence, concurrency, dependency, schema, or production secret changes. Vitest thresholds remain unchanged. The CI validator now checks the exact collector path and static coverage AST, rejecting missing/renamed/lowered thresholds, removed include, matching exclude, comments instead of config, and unverifiable dynamic/spread configuration.

Backup staging/hash/publish-archive-last behavior is retained in a shared tested helper. Mirror independence checks compare volume identity and physical disk number; same-disk partitions, localhost UNC aliases, and unproven virtual/file-backed storage do not qualify. Remote UNC independence means independence from the laptop's local disk, not proof of the remote server's redundancy. Read-only writable evidence is ACL/read-only-media evaluation, not an SMB write probe.

## Production truth

`BACKUP_MIRROR_PATH` is not configured. Backup health is `WARN`, source `LOCAL`; no independent production checksum/restore PASS is claimed. Real `db:mirror:check` must refuse until the owner chooses actual independent storage. Single-drive backup risk remains.

## Tests

The normal coverage pipeline contains eight CI mutation regressions. `check:full` also invokes backup-health regression acceptance: missing/same-volume/same-disk/different-disk/UNC/unavailable/unwritable mirror, real writable/read-only ACL checks, successful and interrupted staging copy, checksum/sidecar/header faults, successful/failed restore evidence, stale backup, fresh retention and contained cleanup. Synthetic identities are scoped to an isolated test process, never production configuration.

`test:backup-mirror:restore` copies a real encrypted backup to an owned temp transport directory, verifies hash and sidecars, corrupts ciphertext with updated checksum to prove authenticated restore refusal, restores the original archive to a separate PostgreSQL database, validates nonempty filters/listings/observations, then deletes the temporary database/files. It explicitly does not prove a physical mirror.

## Acceptance record

All commands used the pinned project CLI `amb.cmd`, not global pnpm.

| Command | Result |
| --- | --- |
| check:full | PASS: 99 test files, 557 tests, policy/PowerShell/crypto/backup-health gates and isolated builds |
| test:coverage | PASS: collector statements/branches/functions/lines 97.86/86.17/100/97.86%; thresholds unchanged 80/80/85/80 |
| test:ci-policy | PASS, including eight mutation regression tests in the test suite |
| test:backup-crypto | PASS: round trip, wrong password and ciphertext tamper |
| test:backup-health | PASS: 30 regression assertions |
| db:backup | PASS: database-20260913-004713.ambbak |
| db:restore:test | PASS: 1 filter, 50 listings, 10669 observations; temporary DB removed |
| test:backup-mirror:restore | PASS: temporary transport, authenticated corruption rejection and nonempty logical restore; not physical independence certification |
| db:mirror:check | SAFE REFUSAL, nonzero exit: actual independent mirror is not configured |
| audit:prod | PASS: no reported production dependency vulnerabilities |
| local:status | Exit 0: services available, backup WARN, queues empty; monitoring STOPPED |

At 2026-09-12T21:50:40Z local backup age was 0.06 hours; latest restore PASS at 00:47:46 Kyiv, source LOCAL. API/PostgreSQL/Redis and supervisor were available. Monitoring was reported STOPPED, with OLX protection until 2026-09-13T09:27:52Z. This task did not start/stop/restart monitoring or bypass protection. Live latency remains INSUFFICIENT_DATA.

## Changed files

| File | Reason |
| --- | --- |
| scripts/collector-coverage-policy.mjs | Static AST validation of actual collector coverage inclusion and minimum thresholds |
| scripts/validate-ci-policy.mjs | Invoke coverage regression protection in the existing CI policy gate |
| tests/collector-coverage-policy.test.ts | Eight config mutation regressions |
| scripts/backup-health.ps1 | Shared read-only health, physical identity, verified staging, metadata-aware retention and contained cleanup |
| scripts/backup-health-cli.ps1 | Sanitized health and strict independent-mirror acceptance CLI |
| scripts/backup-database.ps1 | Reuse tested publish-last helper and strengthen physical independence/retention |
| scripts/test-database-restore.ps1 | Mirror-only/nonempty acceptance, validated complete set, receipt only after successful cleanup |
| scripts/test-backup-health.ps1 | Isolated synthetic identity, real ACL and backup transport regression coverage |
| scripts/test-backup-mirror-restore.ps1 | Real encrypted archive tamper/temporary DB restore acceptance without fake production mirror |
| scripts/status.ps1 | Expose sanitized backup health without failing production for an unset mirror |
| scripts/check.ps1 | Include backup-health regression acceptance in the normal gate |
| scripts/validate-powershell.ps1 | Keep static staging protection aligned with the extracted shared helper |
| package.json | Add backup health/mirror/test commands; no dependency changes |
| .env.example | Explain owner-selected independent storage and honest missing-mirror WARN |
| README.md | Document commands, coverage policy and physical/ACL limitations |
| AUDIT.md | Record operational findings and unresolved physical mirror risk |
| UPGRADE_PLAN.md | Record readiness and conditional next canary prerequisites |
| CHANGELOG.md | Record this scoped operational/regression change |
| docs/BACKUP_READINESS_ACCEPTANCE_2026-09-13.md | This acceptance record and final verdict |

Application source, vitest thresholds, lockfile, database schema and production .env have no diff. Tests passed without observed completeness or Telegram regressions; no new live delivery claim is made.

## Verdict

Coverage regression minimum: protected. Physical independent production copy: not configured/not proven. Independent production restore: pending actual storage. Single-drive risk: remains. Controlled OLX canary readiness still requires natural protection recovery and 30/100 complete live traces; no canary was started by this work.
