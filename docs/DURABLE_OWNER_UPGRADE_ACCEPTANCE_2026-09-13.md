# Durable-owner upgrade: acceptance, 2026-09-13

## Закрытые findings и границы доказательства

Это поэтапные локальные изменения, не production deployment и не полное доказательство zero silent loss. Архитектура, зависимости, OLX baseline 20±4 с, canary 18±3 с, concurrency, cooldown и Telegram global gate не менялись. Rollback: `pre-durable-owner-upgrade-20260913` на `65a055d`; прежний `pre-hotpath-audit-20260909` сохранён.

| Этап | Commit | Реализовано и проверено | Оставшаяся граница |
| --- | --- | --- | --- |
| A01 | `731a906` | Atomic Listing + ListingMatch + PENDING outbox; idempotent reconciler LIVE orphan; настоящий kill/restart и доставка из selector без повторного OLX fetch | Не доказан общий ambiguous Telegram acceptance crash case |
| A03 | `7faaaaa` | Partial batch durable до обработки 403/429/CAPTCHA/quota и отмены; boundary не продвигается | Полная eventual delivery сохранённого batch зависит от A08 |
| A02 | `ebb6c4c` | Vehicle MATCH/NO_MATCH/UNKNOWN; missing не становится mismatch; UNKNOWN deferred и journal сохраняется | Возраст, fairness и bounded повторная hydration требуют A08 |
| A04 | `26d0dea` | Единый fail-closed origin policy, elected owner, persisted pause, запрет direct background OLX HTTP и guard повторных HTTP attempts | End-to-end background → hot-owner replay delivery ещё не доказана; legacy role all не получает OLX ownership |
| A05 | `3acbe7b` | Control Redis bounded; blocking BullMQ semantics сохранены; реальный TCP blackhole GET/SET/EVAL | Восстановление cached producer после Redis disconnect остаётся открытым |
| A06 | `08bb9c4` | Outer finally после acquisition; timer cleanup; renew 0/error/late ACK теряет ownership; abort HTTP; returned batch сохраняется | Cross-resource Redis/PG fencing race не доказан полностью; real replay > TTL открыт |
| A07 | `120884a` | Atomic conditional evaluation update не изменяет NOTIFIED/accepted receipt; stale handler прекращает обработку | Real process acceptance stale evaluation после NOTIFIED входит в незавершённый A17 |

A08 и полный A17 НЕ закрыты. Непрошедшая реализация A08 (retry ownership, lease, pending >48h, hydration reservation), её additive migration и неподтверждённый producer reconnect исключены из итогового дерева. Production schema не менялась.

## Изменённые файлы

- A01: `apps/worker/src/processors/listing-detected.ts`, `apps/worker/src/modules/delivery-outbox.ts`, `apps/worker/src/index.ts`, glue и integration tests.
- A03/A06: `apps/worker/src/processors/collector-run.ts`, `collector-run-helpers.ts`, `apps/worker/src/modules/collector-lease.ts`, `source-http-client.ts`, collector/lease tests.
- A02: `apps/worker/src/modules/filter-engine.ts`, `observation-journal.ts`, `listing-detected.ts`, collector helpers, filter/glue tests.
- A04: `apps/worker/src/modules/olx-request-coordinator.ts`, `source-http-client.ts`, `index.ts`, `observation-replay.ts`, `listing-detected.ts`, origin/replay/integration tests; loopback feed test явно устанавливает разрешающий test-only guard.
- A05: `apps/worker/src/lib/queues.ts`, `tests/redis-control-deadline.test.ts`.
- A07: `observation-journal.ts`, `listing-detected.ts`, terminal CAS/glue tests.
- Малые fixes: `ae34edb` — `apps/api/src/routes/filters.ts` валидирует итоговый merged PATCH и использует transaction-local DB timeouts; `a838b20` — `source-http-client.ts` отменяет unread oversized response body. Добавлены семь реальных Fastify inject range tests и body-cancellation test. `9885d28` — periodic-renewal glue test и fail-closed loopback setup; coverage thresholds не снижались.

## Migration impact

Новых production migrations в итоговой версии нет. Outbox использует существующую `telegram_notifications`; normalizer revision изменена с 4 на 5 для переоценки vehicle filtering. Dry-run acceptance разворачивает имеющиеся 40 migrations только в отдельном временном PostgreSQL. Физический production pgdata, Redis AOF, секреты и `.env` не переносились и не менялись.

## Реальные crash scenarios и результат

Проверки используют временные PostgreSQL/Redis и локальные HTTP fixtures; Telegram fixture принимает запросы, это не отправка настоящему пользователю через внешний Telegram API.

- A01: процесс убит SIGKILL после committed DISPATCHED, до Telegram. Новый child использует delivery selector и BullMQ worker. ID `100008` доставлен один раз, без второго HTTP к источнику.
- Legacy LIVE orphan: reconciler создаёт один intent, повторный запуск создаёт ноль; SHADOW и retention не рассылаются. SHADOW → LIVE проверен отдельно.
- A03: page-one ID `100009`, затем HTTP403; ID остаётся PENDING с normalized snapshot, notification не создаётся, сохранённая граница не меняется. STOPPED аналогично сохраняет `100010` без send/advance.
- A04: новые elected-hot и background children не делают HTTP при persisted pause; expired-pause elected REALTIME probe делает ровно один запрос.
- A05: реальный TCP server отвечает handshake, но не GET/SET/EVAL; control requests отклоняются около 2 секунд, а не ждут бесконечно.
- A06: unit fault tests покрывают bootstrap DB failure, foreign owner, failed renewal, late ACK, single-flight и timer cleanup. Это не заменяет ещё не пройденный multi-process lease-expiry acceptance.

Final full gate `amb.cmd check`: PASS, exit 0. Security ACL/SYSTEM tasks, schema validate/generate, docs, typecheck, lint, PowerShell syntax, backup crypto/health, CI policy, 105 test files / 619 tests и неизменённые coverage thresholds прошли. TypeScript services и dashboard собраны в isolated validation directories; live artifacts не модифицированы.

Final `amb.cmd test:pipeline:resilience`: PASS, exit 0, isolated PostgreSQL:60879 / Redis:60880. Все 40 migrations применены к пустой тестовой базе; дополнительный transactional OLX known-ID reset / favorite retention-lock check прошёл. Стенд остановлен и его временные ресурсы очищены. Строки FAILED внутри fault injection — ожидаемые отрицательные probes при отключённых тестовых БД/Redis; итоговый процесс завершился exit 0.

| Fixture ID | OLX HTTP | Telegram acceptance | Подтверждённый итог |
| --- | ---: | ---: | --- |
| 100001 | 1 | 1 | NOTIFIED, healthy trace |
| 100002 | 1 | 0 | DB unavailable before journal; повторная доступность ID в fixture, не доказанный durable owner |
| 100003 | 1 | 0 | PENDING normalized snapshot; eventual delivery не доказана |
| 100004 | 1 | 1 | HTTP failure → RETRY_PENDING → delivery |
| 100005 | 1 | 1 | DB fault after Telegram acceptance; сохранение retry/lease, полный ambiguity replay не доказан |
| 100006 | 1 | 1 | Redis fault после journal → recovery delivery в проверенном сценарии |
| 100007 | 0 | 1 | Direct SHADOW → LIVE promotion, без HTTP source |
| 100008 | 1 | 1 | SIGKILL → новый child selector / worker → NOTIFIED |
| 100009 | 1 | 0 | Partial collector 403 → PENDING, no send/advance |
| 100010 | 1 | 0 | STOPPED → PENDING, no send/advance |

Итого stand: 9 OLX HTTP, 6 Telegram fixture acceptances; повторных fixture acceptances нет. Это ограниченная acceptance matrix, а не закрытый every-observed-ID owner invariant.

## Silent losses и duplicate cases

В unambiguous A01 kill/restart сценарии: silent loss 0, дубликаты 0, Telegram fixture acceptance 1. Для всех externally observed IDs полное доказательство terminal outcome или реально выбираемого retry owner отсутствует: часть stand assertions подтверждает только наличие journal state. Нельзя распространять частный PASS на A08/A17 или гарантировать exactly-once при потерянном ответе внешнего Telegram API.

## OLX request count до/после

В A01 ID `100008`: count до restart = 1, после restart = 1. Recovery не увеличивает запросы. Persisted pause: 0 HTTP для restarted hot/background; разрешённый elected probe = 1 HTTP. Эти fixture counts не являются production BEFORE/AFTER challenge-rate benchmark. Массовые live OLX requests в ходе апгрейда не запускались.

## Latency regression

Полного сопоставимого live BEFORE/AFTER sample нет, улучшение request-start → Telegram acceptance не заявляется. Существующий stand отдельно сравнивает старую и оптимизированную SQL strategy (40 iterations, 4 против 2 round trips): legacy p50 9.31 ms / p95 24.07 ms, optimized p50 6.48 ms / p95 15.42 ms. Это не benchmark всех новых correctness commits; при N=40 p99 близок к максимуму и не является устойчивой tail-оценкой. Параллельно выполнялась validation build, поэтому значения нельзя переносить на production. Owner/protection guards добавляют контрольные Redis/PG обращения, влияние на live latency требует измерений после отдельного допуска deployment. Полные live p95/p99 и challenge-rate оценки остаются открытыми.

## Protection regression

Unit tests сохраняют preemption и realtime priority; persisted-pause process test проверяет запрет обхода. CAPTCHA не обходится, HTTP403 не переименовывается в подтверждённую CAPTCHA, cadence и защитные cooldown не меняются. По read-only local status production services доступны, monitoring RUNNING; OLX PAUSED после HTTP403 без подтверждённой CAPTCHA, AUTO_RIA LIMITED, RST DISABLED. Это означает, что работающий runtime не равен здоровому OLX мониторингу.

## Known risks и следующий gate

1. A08: убрать возрастное исключение durable pending, обеспечить fairness/backoff и bounded hydration, renew/fence replay, доказать pending >48h и replay > TTL настоящими процессами.
2. Восстановить producer после Redis disconnect и доказать actual enqueue → selector → notification, не только mock reconnect.
3. A17: stale NOTIFIED evaluation в real DB/processes и every-observed-ID owner acceptance; ambiguous Telegram acceptance остаётся отдельным ограничением.
4. OLX production pause и RST challenge требуют разрешённого восстановления источника; защиту не отключать ради статуса зелёный.
5. Независимый backup mirror не настроен; local restore drill PASS не устраняет общую точку отказа SSD.
6. Не выполнены production deployment/restart и GitHub push. Секреты не коммитятся и не публикуются.

Решения согласованы с первичными источниками: разграничение producer и blocking worker connections — [BullMQ](https://docs.bullmq.io/guide/connections); owner-aware lease renewal — [Redis distributed locks](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/); точечные, не глобальные statement/lock timeouts — [PostgreSQL 18](https://www.postgresql.org/docs/18/runtime-config-client.html); consume/cancel response body для connection reuse — [Undici](https://github.com/nodejs/undici#garbage-collection).
