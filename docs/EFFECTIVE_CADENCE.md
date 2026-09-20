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
