# Validation profiles

No production runtime changes, dependency upgrades, test deletions or lowered coverage thresholds.

| Use | Command | Scope |
| --- | --- | --- |
| Focused source edit | `amb.cmd test:related <source-file> [...]` | Tests related through the import graph; no coverage/build |
| Daily pre-commit | `amb.cmd check:fast` | Runtime security, schema/client generation, docs, typecheck, lint, all unit tests |
| Release/CI | `amb.cmd check` / `check:full` / `check:ci` | Existing complete coverage, policy/security/backup checks and isolated production build |
| Crash/recovery acceptance | `amb.cmd test:pipeline:resilience` | Separate isolated PostgreSQL/Redis fault-injection suite |

Fast validation cannot be combined with CI mode. This was verified with a real PowerShell invocation: `-Ci -Fast` exited unsuccessfully before mutation. The normal fast run released its validation lock.

Related tests are not a release gate and do not certify dynamic imports, migrations, PowerShell, configuration or independent integration behavior. No `passWithNoTests` option is enabled. Full checks remain required before release; CI is unchanged.

HP measurement: fast validation PASS, 41.3 seconds total; all unit tests 13.1 seconds. This is a single local timing, not a latency percentile or production performance claim. Tests run on demand, not as production monitoring tasks.

Full validation PASS: 76.4 seconds, 636 tests in 109 files, unchanged coverage gates and isolated build. Fast was approximately 46% shorter in this paired local measurement. A focused `test:related apps/worker/src/processors/observation-replay.ts` selected 10 tests in one file and passed in 3.2 seconds including command startup. Unrelated assertions were not deleted.

The checker reports per-step elapsed time to identify future slowdowns. Commands inside it now use the pinned project `amb.cmd` entry point.
