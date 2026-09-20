# Effective OLX cadence

`GET /monitoring/status` exposes `effectiveCadence`, the cadence the scheduler
actually applies to OLX. It is independent from configuration defaults and does
not modify scheduling.

Fields:

- `mode`: `STANDARD`, `LIVE`, `RECOVERY`, `CANARY`, or `PROTECTED`;
- `intervalSeconds` and `jitterSeconds`: effective values;
- `valueSource`: policy or persisted value that supplied them;
- `reason`: current explanation;
- `changedAt`: time the effective identity last changed;
- `nextExpectedRunAt`: the exact scheduled OLX run time after jitter;
- `history`: newest-first effective identity transitions.

Precedence is `PROTECTED > RECOVERY > CANARY > LIVE/STANDARD`. A change to the
explanation or next run alone updates the current snapshot but does not create a
history entry. A history entry is created only when mode, interval, jitter, or
value source changes.

The migration seeds the snapshot from the existing persisted OLX source row. It
does not change `sources.intervalSeconds`, `sources.jitterSeconds`,
`monitoring_state`, protection state, or canary state.

## Outage deadline

OLX outage detection uses the scheduler evidence attached to each scheduled
realtime job. The deadline is:

`previous nextExpectedRunAt + effective jitter + scheduler tolerance`

The worker does not infer an outage from a fixed age of the last successful
scan. A job without a valid previous scheduler deadline cannot open an offline
recovery window on timing evidence alone. This keeps `STANDARD 120±20s` runs,
normal scheduler delay, protected cadence, and recovery ramps from creating
false recovery pressure while still detecting a real restart after intentional
downtime.

`OLX_SCHEDULER_TOLERANCE_SECONDS` is a bounded execution-delay allowance after
the cadence jitter. It does not change request cadence.
