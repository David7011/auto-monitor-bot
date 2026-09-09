# Old versus new migration comparison

The old column is audited. The HP column must be filled from live commands; it is intentionally not marked verified yet.

| Check | Old Lenovo | New HP ProBook 445 G9 | Gate |
|---|---|---|---|
| OS/build | x64, build 26200 | Windows 11 Pro x64, build 26200 | recorded live |
| Timezone | FLE Standard Time / Kyiv | FLE Standard Time / Kyiv | passed |
| Project path | `D:\auto-monitor-bot` | `C:\Projects\auto-monitor-bot` | scripts use project-relative paths |
| Git revision | `bfd0a1ab...d28b` + dirty tree | exact `bfd0a1ab...d28b`; preserved tree plus user-requested Android removal | passed with intentional HP-only change |
| Git remote | GitHub David7011/auto-monitor-bot | same GitHub URL | passed |
| Node | 24.18.0 | 24.18.0 | passed |
| pnpm | 10.34.5 | 10.34.5 | passed |
| PostgreSQL | 18.6 | 18.6 | passed |
| Redis | 8.8.0 | 8.8.0 | passed |
| Applied migrations | 38 | 38 after final restore/deploy | passed |
| Filters/listings | 1 / 40 at audit time | final dump restored; 1 active filter; new live listings persisted | passed |
| Redis/BullMQ | AOF, queue runtime reconstructable | live runtime healthy; failed/recent-failed 0 after recovery retry | passed |
| Docker/WSL | unused/not installed | NOT REQUIRED | do not install without need |
| Scheduled tasks | 4 SYSTEM tasks | 4 regenerated SYSTEM tasks installed; main task fresh-run verified | passed |
| Ports | 3001, 4000, 55432, 6380 | 3001, 4000, 55432, 6380 listening in production session | passed |
| Tests | prior full gate 355 tests; rerun pending | typecheck/lint/build passed; 355/355 tests; extended resilience passed | Android removed by user request |
| Runtime | stopped for cutover | running; OLX active; two hot replicas and background worker healthy | passed |

Status: `VERIFIED`. Controlled cutover, live OLX-to-Telegram exactly-once evidence, ACL hardening and SYSTEM autostart were verified on the HP on 2026-09-08.
