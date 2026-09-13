# OLX Windows transport recovery — 2026-09-13

## Result

Production OLX recovered to ACTIVE, with a successful REALTIME collector run and actual Telegram acceptance receipts. This is a transport compatibility fix on the HP, not a CAPTCHA solver. A long-term challenge-rate or completeness guarantee is not claimed.

## Evidence and implementation

The same public search URL and principal request headers returned CloudFront403 / zero cards through Node.js, including a diagnostic with HTTP/2 enabled. The built-in Windows HTTP client returned HTTP200 / 52 rendered cards. WinHTTP had no configured proxy; no OLX hosts override was found. The exact remote rejection rule cannot be identified from the client response alone.

`apps/worker/src/lib/windows-source-http.ts` owns one persistent Windows PowerShell helper. `scripts/windows-source-http.ps1` uses Windows HttpWebRequest with keep-alive and TLS certificate verification. Only HTTPS GET to `www.olx.ua` is accepted in production. There are no proxy services, credential transfers, browser cookies, CAPTCHA solvers, or dependency installations. Other sources retain their existing HTTP transport.

The caller still goes through the OLX coordinator and its ownership, priority, circuit and retry policies. Aborting the request terminates its helper; the next allowed request creates a fresh helper. The helper exits on parent stdin EOF. Both Node and Windows bound request time and response size. Redirects are returned to the existing classification layer rather than followed to another origin. Status, Retry-After, cf-mitigated, Content-Type and Age are preserved. UTF-8 bytes are transferred through bounded base64 IPC; compressed bodies are read with a decompressed-size limit.

Actual headers-received and body-received timestamps are captured inside the helper. Native requests do not emit Undici DNS/TCP/TLS diagnostic events; those detailed network fields remain unavailable rather than fabricated. Full body buffering and IPC have CPU/RAM overhead; optimize only against measurements. The healthy production trace below includes that overhead.

## Tests and build

- Native loopback acceptance on Windows: UTF-8 content, 200/403/429, protection headers, stage timestamps, chunked oversized response, redirect refusal, unsupported host, abort and fresh-helper recovery.
- Existing source HTTP / coordinator tests: 40 targeted tests passed including the three native tests.
- Worker typecheck, ESLint, PowerShell syntax checks passed.
- Full `amb.cmd check` passed, including unchanged coverage thresholds and isolated service/dashboard build.
- Direct native acceptance against the actual OLX URL: HTTP200, 51 rendered cards, 3,898,397 bytes, approximately 3,068 ms including helper startup.

## Production deployment and rollback

Rollback tag: `pre-olx-windows-transport-20260913` at the pre-change source HEAD. Runtime rollback copy: `.runtime/audit/olx-transport-rollback-20260913/source-http-client.js`, SHA256 `BC834E6C7725807297D71A84FDB2403A6B6E3AA7D76ABFABBDADED5F5AC392BA`.

This was a selective runtime hotfix: the existing deployed `apps/worker/dist/collectors/source-http-client.js` received only the transport call/timing/shutdown changes, together with the compiled new `dist/lib/windows-source-http.js` and helper script. Other un-deployed correctness changes on main were NOT deployed. The runtime is therefore the prior deployed build plus this documented patch, not a full build of the current main.

The deployment script conditionally verified the original module hash, stopped monitoring through its API, waited for zero active queues, installed the two JS artifacts and restarted only the three workers through `recover.ps1`, then resumed monitoring. API, dashboard, PostgreSQL and Redis were retained. Initial deployment attempts received HTTP415 before artifact mutation; specifying JSON Content-Type fixed the deployment request. No database migrations or `.env` changes were required.

To roll back: pause monitoring and drain active work; restore the recorded original module; restart the workers through the existing recovery workflow; resume monitoring with OLX protection intact. The additional unused helper/module may remain on disk. A full future build must include the committed source change and helper script. Do not describe a selective hotfix as deployment of all commits on main.

## Live production acceptance

The first successful native worker run:

- Started: `2026-09-13T17:54:00.179Z` (20:54 Kyiv).
- Finished: `2026-09-13T17:54:04.551Z`; status SUCCESS, lane REALTIME, one source request.
- 17 normalized observations persisted: 11 NOTIFIED, six REJECTED by existing filters.
- For IDs `934719512`, `934719633`, `934720781`, `934721287`, `934721552`: request start `17:54:00.197Z`, headers `17:54:02.641Z`, body complete `17:54:04.070Z`, Telegram accepted `17:54:04.784Z`.
- Request-start → Telegram acceptance: 4,587 ms for those same-pass observations. They are not independent samples and cannot support a p95/p99 claim.
- OLX source transitioned to ACTIVE, lastError cleared, pausedUntil cleared by its successful worker path.
- Both hot replicas were healthy and REDUNDANT after restart.
- The next automatically scheduled REALTIME run (`17:56:05.709Z` → `17:56:08.153Z`) also completed SUCCESS with one HTTP request, zero new observations and no new notifications. The initial 11 NOTIFIED records remained unchanged. This confirms continued operation beyond the manually authorized recovery opportunity; it is still a small observation window.

Existing background cooling remains in force (the observed coverage attempt was SKIPPED); recovery boundaries were not manually verified or reset. Observed production source cadence is 120±20 seconds, preserved by this fix. Restoring 20±4 cadence would be a separate configuration decision and should account for the new post-recovery sample.

The HTTP200 diagnostic does not prove every remote listing was captured. The source recovery and real acceptance receipts above prove that collection and notification resumed for the tested live pass; unfinished A08/A17 recovery guarantees remain as recorded in the durable-owner report.

## References

- [Microsoft HttpWebRequest](https://learn.microsoft.com/en-us/dotnet/api/system.net.httpwebrequest): existing Windows API used by the helper. It is a compatibility choice for the installed Windows runtime; Microsoft recommends HttpClient for new general-purpose development.
- [AWS CloudFront403](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/http-403-permission-denied.html): client-visible 403 does not uniquely identify a WAF versus origin rule.
