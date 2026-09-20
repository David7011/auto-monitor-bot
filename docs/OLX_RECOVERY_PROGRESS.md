# OLX recovery progress

Pending OLX continuity recovery keeps two independent durable concepts:

- `recoveryProgressPage` is the next never-scanned page. It is monotonic and is
  the only cursor used to resume after a process crash or laptop restart;
- `recoveryOverlapPage` and `recoveryOverlapExternalIds` retain evidence from
  the last completed page. They document mutable-offset overlap but never move
  the progress cursor backwards and never prove a recovery boundary alone.

The lane arbiter reserves at most one deep page between realtime completions.
If no slot exists it returns immediately. The attempt persists
`NO_PROGRESS + reason`, increments `recoveryConsecutiveNoProgress`, and queues a
bounded exponential retry (`5s`, `10s`, `20s`, `40s`, then at most `60s`). The
API scheduler also honors `recoveryNextAttemptAt`, so a restart cannot bypass
the durable backoff.

Only a frozen known-tail anchor or an observed timestamp at/before the required
cutoff can transition a pending window to `VERIFIED`. Progress and overlap
evidence by themselves are never verification evidence. Realtime has priority
both in the lane arbiter and in the single-origin request coordinator.
