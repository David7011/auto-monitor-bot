# auto-monitor-bot — agent operating rules

Production goal (highest priority): instant monitoring. New matching listings
must fly to Telegram in seconds, with zero misses and zero errors. Every
change is judged against latency, reliability and silence (no Telegram spam).

## Production layout (do not improvise paths)

- Production repo: `C:\Projects\auto-monitor-bot` (runs as SYSTEM via the
  `Auto Monitor Bot` scheduled task: `scripts\supervisor.cmd`, Boot+Logon).
- Ports: API `:4000`, dashboard `:3001`, Redis `:6380`, PostgreSQL `:55432`.
- `C:\Users\HP\Documents\Codex\...\auto-monitor-bot` is a DIVERGED copy.
  Never copy it over production.
- Temp scratch only in `C:\Users\HP\AppData\Local\Temp\opencode\`.

## Release gate (mandatory for any prod-code change)

Edit → `tsc --noEmit` (all) → `eslint` touched files → `vitest run` (full,
must be green and stderr-clean) → clean tree → commit →
`create-release.ps1` → `.\amb.cmd local:restart` (needs interactive UAC "Yes")
→ `POST /monitoring/live/start` (restart always leaves monitoring STOPPED).
Test-only / docs-only / `.env.example`-only changes need no restart.
DB-code changes need a worker rebuild; API changes need an API rebuild.

## Hard prohibitions

- **NEVER run `pnpm install`, `pnpm update`, `pnpm approve-builds`, `pnpm store
  prune`, `rimraf node_modules`, `tsc -b --clean`, or anything else that
  touches `node_modules/`, `dist/` or the pnpm store while production is
  live — without explicit user approval in this session.** Rewriting modules
  under running SYSTEM processes has killed the live API before (supervisor
  self-heal restarted it). Dependency updates are done only via pinned
  `pnpm.overrides` + full green suite, and only when the advisory touches a
  real prod runtime path (dev-only tooling CVEs are accepted risk).
- **NEVER `prisma db push`, `migrate dev/deploy`, or hand-edit prod data**
  without explicit approval. Read-only probes use
  `pnpm --filter @amb/db exec tsx <script>` + `process.exit(0)` at the end.
- **NEVER commit secrets.** Real tokens live only in git-ignored `.env`.
- **NEVER commit, push, or open PRs** unless explicitly requested.
- **NEVER delete untracked local scratch** (`work/`, `.runtime/*` profiles,
  Temp scripts) without asking — it may be someone's work.

## Shell quirks (Windows PowerShell 5.1)

- No `head`/`tail`/`&&`/`||`. Chain with `;` or `cmd; if ($?) { next }`.
- Use `pnpm.cmd`, quote paths with spaces, never `cd` (use `workdir`).
- Inline `node -e` breaks on `$`/`$_` — write `.mjs`/`.ps1` files instead.
- ESM absolute imports need `pathToFileURL(...).href`.
- `SELECT COUNT(*)::int` (BigInt is not JSON-serializable).
- `regclass::text` quotes mixed-case identifiers — match with `LIKE`/`lower()`.

## Monitoring invariants (verify after every restart)

- `/health`: `monitoring=RUNNING`, `activeSources=2` (OLX 20s + AUTO_RIA 60s),
  fresh `lastSuccessfulScan`, `codeRevision`/`releaseId` = accepted release.
- `redis=WARN` is stale-window noise only if `failedRecent` jobs are old;
  new failures need a reason check (`failedReason` in `bull:<queue>:<id>`).
- `AUTO_RIA LIMITED` with the novelty-caveat `lastError` is by design.
- Full suite must stay at 100% green; any stderr noise is a bug.

## Latency budget (do not regress)

- OLX realtime tick p50 ~9s on a 20s cadence; ARIA p50 ~0.7s on 60s.
  firstSeen→Telegram p50 ~5-9s (OLX), ~1s (ARIA).
- OLX HTTP is serialized by its coordinator (`maxInFlight=1`, origin
  protection) — NEVER parallelize OLX origin requests; ARIA has no
  coordinator and tolerates bounded parallelism with a protection sentinel.
- Telegram gate stays 1100ms (Bot API anti-ban); bursts are handled by flash
  bundles, not by shrinking the interval. `send gate wait >3s` warnings mean
  the gate binds — investigate before touching the interval.
- publication→detection p50 ~16min is SOURCE-side lag (site indexing +
  backfill tail), not collector slowness. Do not chase it with cadence.

## Known environment quirks

- **PostgreSQL clock runs +3h ahead of real UTC** (`SELECT NOW()` =
  OS time + 3h). App logic is unaffected (every timestamp the code compares
  is app-clock-set; the offset is uniform so orderings hold), but NEVER use
  bare `NOW()`/`CURRENT_TIMESTAMP` in SQL — pass app `Date` params instead.
  Monitoring probes must build time windows from the app clock
  (`new Date(Date.now() - ...)`) and pass them as parameters, never
  `NOW() - interval`.
