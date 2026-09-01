# Полный аудит Auto Monitor Bot — 2026-08-30

## Цель и границы

Проект оценивался под laptop-first модель: он работает только пока ноутбук включён. После включения realtime обязан стартовать первым, а пропущенное за выключенное время окно восстанавливается newest-first в более низком приоритете без голодания hot-path.

Абсолютно доказать «мы всегда первые» для внешнего сайта невозможно: OLX не предоставляет API чтения чужих объявлений, выдача может индексироваться с задержкой, а CAPTCHA/rate limit находятся вне контроля проекта. Реалистичный инженерный инвариант проекта:

1. Любое увиденное объявление сначала получает долговечную запись восстановления.
2. Realtime всегда обгоняет backfill, enrichment и обслуживание.
3. Сбой процесса, Redis, PostgreSQL или Telegram не превращает увиденное объявление в молчаливую потерю.
4. Любой недоказанный участок покрытия становится явным recovery-gap.

Запрещённые обходы CAPTCHA, подмена fingerprint, взлом аккаунтов, прокси-ротация для обхода блокировок и эксплуатация закрытых интерфейсов не являются улучшением: они повышают вероятность долгой блокировки основного источника и юридический риск.

## Итоговая оценка

| Область | Оценка | Вывод |
|---|---:|---|
| Локальная сохранность увиденного объявления | 9/10 | Crash-window до PostgreSQL закрыт; fault-injection инвариант прошёл |
| Hot-worker и failover | 9/10 | Две реплики, согласованный Redis lease, измеренный failover 4,539 с |
| OLX hot-path | 8/10 | Одна newest-first страница; p50 5,232 с, p95 14,193 с на первом live-срезе |
| Telegram first response | 8/10 | Общий Redis gate и newest-first burst-order; лимит одного чата остаётся внешним |
| Полнота после выключения ноутбука | 8/10 | Persisted boundary, newest-first recovery и observation replay присутствуют |
| Наблюдаемость | 8/10 | Метрики и truthful STOPPED/IDLE; нужен отдельный SLO для hot-stage OLX |
| Автотесты | 7/10 | 266 тестов и сильная branch coverage, но statement coverage критических processors низкая |
| Источники | 6/10 | Реально быстры OLX и Cars.ua; RST защищён CAPTCHA, остальные ограничены точностью/квотой |

Общая инженерная оценка: **8/10**. Локальная архитектура уже сильная; главное оставшееся ограничение — внешняя доступность и внутренняя связь OLX direct scan с периодической reconciliation в одном collector run.

## Что проверено

- 370 файлов в `apps`, `packages`, `tests`, `scripts`, `docs`.
- API, dashboard, hot/background workers, PostgreSQL, Redis/BullMQ, autostart, supervisor, watchdog, очередь recovery и журнал наблюдений.
- Парсинг/нормализация источников, newest-first правила, фильтры, дедупликация, Telegram lease/rate gate, retention.
- Полный gate: security, Prisma validate/generate, docs drift, typecheck, ESLint, PowerShell syntax, coverage, production build.
- Production dependency audit: известных уязвимостей нет.
- 64 test files / 266 tests: все прошли.
- Coverage: statements 30,94%, branches 73,51%, functions 46,99%, lines 30,94%.
- Изолированная fault-injection с отдельными PostgreSQL/Redis/fake OLX/fake Telegram.
- Forced-kill текущего hot-лидера и автоматическое восстановление redundancy.
- Живой OLX LIVE после deploy.

## Исправления этого этапа

### P0 — устранена потеря между Redis claim и PostgreSQL

Раньше hot-worker мог поставить Redis claim на 6 часов и упасть до первой записи `source_seen_listings`. Повторное обнаружение считалось hot duplicate, а observation replay не имел записи для восстановления.

Теперь:

- normalized snapshot записывается в PostgreSQL до claim;
- queued handoff явно сообщает, что snapshot уже сохранён;
- claim хранит случайный owner token;
- освобождение выполняется Lua compare-delete;
- старый владелец не может удалить claim нового worker после истечения TTL;
- TTL сокращён с 21 600 до 120 секунд;
- постоянная дедупликация остаётся за PostgreSQL unique constraints и Telegram DB lease.

### P1 — свежие объявления больше не проигрывают siblings в Telegram

Все ожидающие операции по-прежнему разделяются по lane. Внутри одинакового lane следующий слот получает объявление с самым новым `publishedAt`, а при его отсутствии — самым новым `firstSeenAt`. Это устраняет наблюдавшийся startup burst, где более старый queued sibling мог обогнать более свежий.

### P1 — глубокий OLX scan вынесен из realtime-глубины

`OLX_REALTIME_MAX_PAGES` изменён с 5 на 1 во всех runtime examples и рабочей конфигурации. Если страница 1 не достигает известного хвоста, `coverageGap` ставит durable recovery в `collector.backfill`. Этот job прерываем realtime-запросом и сохраняет persisted coverage boundary.

### Наблюдаемость

- `STOPPED` больше не даёт ложный `FAIL` live-покрытия.
- BullMQ failed history отделена от recent failures (окно 30 минут).
- Четыре stalled jobs от теста 25 августа остаются видимыми, но Redis теперь корректно `OK`, потому что живого сбоя нет.

## Измерения после deploy

Первый live-срез после включения нового кода:

- startup command → завершённый первый OLX scan: 11,930 с;
- первый OLX scan стартовал практически сразу, выполнил 1 страницу / 3 reconciliation-запроса за 11,029 с;
- 9 последовательных OLX realtime runs: p50 5,232 с, p95 14,193 с;
- start-gap: p50 17,88 с, p95 21,84 с;
- максимум страниц: 1;
- максимум запросов в run: 3;
- overflow warnings: 0;
- recent BullMQ failures: 0;
- PENDING/FAILED/unresolved observations за 24 часа: 0/0/0;
- hot redundancy: `REDUNDANT`, leader consistent;
- forced leader failover: 4,539 с, затем redundancy восстановлена.

Срез короткий и не является долгосрочным SLO-baseline. Ускорять cadence ниже 20 ± 4 секунд только по девяти проходам нельзя: p95 уже приблизился к минимальному интервалу из-за reconciliation-run.

## Оставшиеся слабые места и лучшие следующие апгрейды

### P1. Reconciliation всё ещё удерживает OLX source lock

Первая direct-страница передаёт hot candidates прогрессивно, но региональная/HTML/private сверка продолжает тот же collector run. В reconciliation-момент p95 вырос до 14,193 с, а отдельный run занял 15,896 с. Это почти весь минимальный healthy cadence.

Лучшее исправление: отдельная durable очередь `collector.coverage` и отдельный scheduler tick. Realtime job должен завершаться сразу после direct page 1 и записи continuity result. Coverage job использует тот же preemptible origin coordinator, но не удерживает realtime source lock. Ожидаемый эффект: first-scan completion приблизится к обычным 2,5–6,5 с, появится безопасный запас для canary cadence 15 ± 3 с.

### P1. Telegram физически сериализует burst в одном чате

Telegram рекомендует не превышать примерно одно сообщение в секунду в одном чате. В старом startup burst 17 карточек дали detection→Telegram p95 около 24 с. Newest-first ordering исправляет приоритет, но не физический лимит.

Лучшее исправление: `flash bundle` на burst — одно немедленное сообщение со списком 5–15 новых ссылок newest-first, затем подробные карточки/обновления идут ниже приоритетом. Это сообщает обо всех объявлениях в первый разрешённый слот, не нарушая rate limit. Потребуются отдельные idempotency и retention tests.

### P1. Cadence должен управляться доказательствами, а не фиксированным числом

После минимум 100 чистых OLX runs считать p95 direct-stage, p95 full-run, долю protections, overflow и recovery count. Только если direct p95 < 8 с, full p95 < 12 с, protections/overflow равны нулю, canary может перейти 20 ± 4 → 15 ± 3. При первом adverse signal автоматически вернуть 20/30/60. Слепой возврат к 4 секундам повышает риск долгой блокировки и не даёт устойчивого лидерства.

### P1. Нужен отдельный hot-stage SLO

Текущий `CollectorRun.finishedAt` включает reconciliation, поэтому startup-to-first-candidate не измеряется точно. Следует сохранять:

- scheduler due → request start;
- request start → first byte;
- first byte → normalized hot candidate;
- candidate → durable observation;
- observation → first Telegram request start;
- Telegram start → accepted;
- recovery gap open → closed.

Цели: page-1 scheduling p95 < 1 с после due, hot processing p95 < 100 мс без сети, unresolved observations = 0, recovery boundary never regresses.

### P1. Рабочее дерево не имеет чистого checkpoint

В дереве накоплен большой набор связанных предыдущих изменений. Пока они не зафиксированы проверяемым commit/tag, откат и сравнение production baseline сложнее. После ручного просмотра нужен один checkpoint с текущими 266 тестами, хешем build и evidence JSON; затем следующие P1 выполнять отдельными небольшими commit.

### P2. Критические processors имеют слабую statement coverage

Общая branch coverage хорошая, но `collector-run.ts`, `listing-detected.ts`, `observation-replay.ts` почти не покрываются обычным unit coverage и проверяются главным образом отдельной fault-injection приёмкой. Нужны dependency-injected processor tests для точных crash points и обязательный extended acceptance в release checklist.

### P2. Портфель источников ограничивает реальную конкуренцию

- OLX — главный быстрый канал, но официальный API не читает чужие объявления.
- Cars.ua — полезный быстрый резерв, но это другой индекс.
- AUTO.RIA ограничен официальной квотой; дополнительная легальная квота даст прямой прирост.
- AutoMoto не даёт точное время публикации.
- RST находится в корректной защитной паузе из-за CAPTCHA.

Полезный путь — официальные API/партнёрский доступ и независимые публичные источники. Обход защиты RST/OLX не входит в безопасную архитектуру.

### P2. Major dependency upgrades не дают прямого hot-path выигрыша

Текущий production audit чист. Prisma 8 RC, BullMQ 6, ioredis 6, Undici 8 и другие major версии нельзя обновлять одним пакетом: сначала compatibility branch, migration notes, perf baseline и полный fault gate. Это maintenance, а не первоочередное ускорение.

## Рекомендуемый порядок следующего этапа

1. Зафиксировать чистый checkpoint текущего validated runtime.
2. Разделить `collector.realtime` и `collector.coverage` на уровне durable queues/source lock.
3. Добавить точные hot-stage timestamps и накопить 100+ clean runs.
4. Реализовать Telegram flash bundle для burst и доказать idempotency.
5. Включить SLO-driven 15 ± 3 canary с автоматическим rollback.
6. Поднять processor statement coverage и сделать extended acceptance обязательным release gate.

## Официальные ограничения, учтённые в решении

- OLX Developer FAQ: официальный API не позволяет читать чужие объявления.
- Telegram Bot FAQ: для одного чата следует избегать частоты выше одного сообщения в секунду; иначе возникают 429.
- Telegram Bot API: `retry_after` должен управлять повторной отправкой.
- BullMQ: lower numeric priority выполняется раньше; stalled jobs означают at-least-once семантику и требуют idempotent processors.
- Redis distributed locks: освобождать lease нужно только при совпадении owner token.
