# Полный аудит Auto Monitor Bot: обнаружение, реакция и скорость

**Статус upgrade:** AUTO.RIA public 60 с выполнен в релизе `3c310f2787c4-20261012172412`; runtime gaps 57,9 и 62,5 с подтверждены. [OLX recovery](OLX_RECOVERY_UPGRADE_2026-10-12.md) выпущен в `a4a24a50bd06-20261012210057`, gate 137 файлов / 862 теста. Ниже сохранён исходный аудит предыдущего релиза. Актуальный порядок оставшихся этапов: [план upgrade](UPGRADE_STAGES_2026-10-12.md).

Дата: 12 октября 2026. Рабочий проект: `C:\Projects\auto-monitor-bot`. Проверенный релиз: `7c633bd37d91-20261012160044`, commit `7c633bd37d91125cbbef97c1e2df8011b478f0b2`.

Обновление 13 октября: [этап 3, передача кандидатов](CANDIDATE_HANDOFF_UPGRADE_2026-10-13.md) выпущен в `5a54641cca0c-20261012210907`. Ожидание всех saved-search страниц OLX устранено; AUTO.RIA получил stage timestamps. Gate 138 файлов / 865 тестов. Новая production latency-выборка пока отсутствует; следующий этап — Telegram.

## Вывод

Главный резерв скорости находится до первой отправки: частота и полезность поисковых запросов, передача уже готовых кандидатов, поведение при burst и ожидание следующих получателей. Базовый путь от готового OLX-кандидата до Telegram уже имеет медиану около секунды. Удаление дешёвых проверок доступа или durable journal не устраняет минутный polling AUTO.RIA, старую выдачу источника и хвосты recovery.

Первая задача следующего этапа — AUTO.RIA public cadence. Затем recovery OLX и своевременный handoff готовых feed results. Панель требует отдельного перехода от многосекундного polling к событиям. Защитные механизмы рассматриваются как инженерные компромиссы по измеренной цене и влиянию на availability. Существующие Chromium sandbox settings и challenge automation сохранены по указанию пользователя.

## Что именно проверено

Просмотрена структура 361 файла apps/packages/scripts. Подробно разобраны активные collectors OLX и AUTO.RIA, source scheduler/control, coordinator и source HTTP, normalization/filter/dedupe, journal/replay/outbox, Telegram send/flash/update/retention, roles/leadership/leases/bootstrap, seller phone/market/vehicle/OCR, API/BFF/dashboard refresh, schema/indexes, supervisor/watchdog/release и backup entrypoints. Не утверждается, что каждая строка всех 361 файлов проверена или что все dormant collectors были запущены.

Активно работают два источника. Остальные adapters и внешние vehicle providers проверены как фоновые/дополнительные пути; live E2E для каждой внешней площадки в этом аудите не выполнялся. Массовый нагрузочный тест работающего monitoring не запускался. Изменены только инструкции и отчёты; production-код и конфигурация этим аудитом не менялись.

Доказательства разделены на:

- **Подтверждено:** код, runtime-ответ или сохранённая строка трассы.
- **Кандидат:** механизм в коде есть, но его вклад в задержку требует отдельного опыта.
- **Продуктовое решение:** результат зависит от определения новизны/полезной первой реакции.

## Текущее состояние

На 19:52–19:54 по Киеву API сообщает нужный release/commit, `monitoring=RUNNING`, `activeSources=2`. Leader и standby свежие; background heartbeat свежий. Event-loop delay p95 около 34 мс, hot utilization в одном снимке 0,1153. Это не признак постоянного CPU saturation и не длительное исследование загрузки.

P0 полностью проверен на исходном хвосте: **283/283** старых receipts завершили очистку, сохранены **283** dedupe tombstones. Исходных записей с messageId осталось **0**, retention due/overdue/unmanaged/invalid равны **0**, health `OK`, ошибок этой очистки больше нет. Дополнительный CLI сообщил 98 удалений, 101 skipped при конкурентной обработке и один transient retry; оставшуюся работу завершил штатный worker. Skipped не означает потерю: данные сопоставлены по исходным ID.

Расширенный release gate предыдущего этапа: 132 test files, 831 tests, types/lint/coverage и isolated production build прошли. Новая production-сборка для read-only аудита не требовалась; эти 831 тест не представлены как новый запуск в текущем аудите.

## Как измерять основную цель

Нужны четыре независимые задержки:

1. Объявление стало доступно в конкретной ленте → следующий запрос ленты.
2. Запрос ленты → готовый matching candidate.
3. Candidate → подтверждение Telegram API первой полезной реакции.
4. Подтверждение/событие → отображение в панели.

Source-reported publication timestamp не доказывает момент доступности в нашей ленте. Telegram API acceptance не измеряет пуш на телефоне или прочтение. Для public AUTO.RIA оригинальное время публикации и полнота исторического окна не доказаны.

Текущий `firstSeenAt` OLX передаётся от scan timestamp и бывает раньше request на 5–15 секунд. Он нужен существующим freshness/dedupe правилам; его нельзя переопределить только ради красивой метрики. SLA реакции следует считать от candidate event с сохранением остальных этапов.

### Свежий снимок

Источник: `.runtime/audit/full-audit-20261012-1791823928512.json`, до `2026-10-12T16:52:08Z`, запрос окна 24 часа. Это доступная история, не непрерывный 24-часовой benchmark. В OLX cohort 186 realtime observations, acceptance timestamps у 76; AUTO.RIA 110 и 103. Разница включает отказы фильтра и не равна числу пропусков.

| Показатель | OLX p50 / p95 | AUTO.RIA p50 / p95 |
|---|---:|---:|
| firstSeen → accepted | 9,059 / 13,600 с | 1,027 / 2,802 с |
| ready hot candidate → accepted | 1,003 / 2,757 с | нет эквивалентной трассы |
| parsed → hot candidate | 0,020 / 5,220 с | нет эквивалентной трассы |
| Продолжительность realtime scan | 9,277 / 14,176 с | 0,784 / 3,954 с |
| Между началами успешных сканов | 20,005 / 23,713 с | 119,971 / 124,697 с |

Редкие OLX dispatch waits 42–44 секунды относятся к более ранней истории. Причину каждого случая следует привязать к request/receipt/release; переносить их как постоянный p95 текущего релиза нельзя. p99 при 76 принятиях недостаточно устойчив для SLA. Перцентили отдельных этапов не складываются.

### Панель/API

Два коротких последовательных read probes без нагрузочного теста:

| Endpoint | Наблюдённое время | Размер второго ответа |
|---|---:|---:|
| /health | 169–184 мс | 3 937 bytes |
| /monitoring/status | 66–90 мс | 13 500 bytes |
| /metrics | 58–268 мс | 30 145 bytes |
| /listings/recent?limit=9 | 17–29 мс | 112 602 bytes |

Это отдельные measurements, не распределение p95. При ответе API за десятки миллисекунд период UI refresh 3–10 секунд намного больше транспортного времени. Девять объявлений дают ~112 KB, потому что list response включает полные модели и связанные записи: есть резерв projection/payload.

## Приоритеты следующей работы

| ID | Находка | Доказанность | Основной эффект |
|---|---|---|---|
| P1-01 | API quota растягивает AUTO.RIA public LIVE до 120 с | подтверждено | уменьшить ожидание polling |
| P1-02 | 464 unresolved OLX recovery windows | подтверждено состояние; причины требуют разбора | полнота + сокращение повторной нагрузки |
| P1-03 | parsed→candidate p95 5,22 с | подтверждено метрикой | убрать ожидание готового результата |
| P1-04 | Sequential recipient delivery и album debt | подтверждено кодом | быстрая первая реакция каждому |
| P1-05 | Candidate/send SLA и scan timestamp смешаны | подтверждено | правильная диагностика и canary |
| P1-06 | Панель ждёт polling 3–10 с | подтверждено | мгновенный визуальный отклик |
| P1-07 | Definition of duplicate по VIN/plate может скрывать новое объявление | продуктовый выбор | полнота нужных пользователю событий |
| P2-01 | Replay backoff пять минут общий для durable work | подтверждено кодом | сократить восстановление свежей работы |
| P2-02 | Hot включает enrichment/coverage/backfill | подтверждено архитектурой | снизить конкуренцию при burst |
| P2-03 | Saved AUTO.RIA feeds повторяются по contexts, rest Promise.all без cap | кандидат + подтверждённая структура | запросы и устойчивость масштабирования |
| P2-04 | Seller-phone cache без single-flight | подтверждено отсутствием механизма в этом пути | убрать одновременные одинаковые lookup |
| P2-05 | Market/vehicle/phone порождают повторные updates | кандидат | освободить Telegram slots |
| P2-06 | Telegram send объединён с enqueue enrichment | подтверждено | убрать лишние retries уже принятой отправки |
| P2-07 | Большие list payloads и тяжёлый metrics polling | подтверждено | UI, API pool, меньше serialization |
| P2-08 | HTML/base64 IPC копирует body | подтверждено; эффект нужно измерить | десятки/сотни мс обработки |
| P2-09 | Runtime CHECK отсутствуют при наличии migration | подтверждено | статусная целостность без будущих циклов |
| P2-10 | Maintenance CLI Redis connect/disconnect неполон | подтверждено | надёжный запуск и завершение CLI |
| P2-11 | Supervisor/lease/readiness имеют разные пороги | подтверждено | прогнозируемая реакция на зависания |
| P2-12 | Release helper может ждать handles после ready | наблюдалось при P0 | короткий предсказуемый выпуск |
| P3-01 | Повторная нормализация при многократных filters | кандидат | масштабирование числа фильтров |
| P3-02 | Journal upserts per item | подтверждено; сейчас быстрый stage | burst throughput |
| P3-03 | Index/pool tuning без query durations не обоснован | подтверждено ограничением данных | выбирать реальные DB bottlenecks |
| P3-04 | OCR/provider budgets и cache lifetime | кандидат | быстрые фоновые результаты без конкуренции |
| P3-05 | Документация расходится с реализацией | подтверждено | меньше неверных изменений и действий |

## P1: подробно

### P1-01. AUTO.RIA public cadence

`apps/api/src/modules/monitoring/control.ts:autoRiaLiveIntervalSeconds` использует `ceil(3600/hourlyLimit)` независимо от access mode. `AUTO_RIA_HOURLY_REQUEST_LIMIT=30` даёт 120 с при LIVE minimum=60. Обе env-схемы по умолчанию используют public. Runtime source и реальный gap подтверждают 120 с.

Изменение: отдельный public polling interval, official API budget только для API. Обработать fallback API→public как смену effective mode, а не оставить прежнюю квоту. При uniform arrival переход 120→60 с уменьшает среднее ожидание следующего опроса примерно на 30 с; это математическая оценка polling, не гарантия публикационного SLA.

Проверка: public с quota 30, API с тем же quota, rejected key fallback, много contexts, rate limit и stop/start. Затем controlled сравнение реальных gaps и source availability. Предельная частота public ещё не измерена; 30/15/5 секунд не обещаются как устойчивые значения.

### P1-02. OLX recovery

Новый снимок: 464 `UNRESOLVED/UNSTABLE_PAGINATION`, 193 verified, одно pending. В предыдущем снимке было 440 unresolved — за ~56 минут добавилось 24. В свежем окне COVERAGE 516 runs/816 requests/0 new, BACKFILL 1683/1104/0 new. Нулевой new сам по себе не повод отключить поиск хвоста: coverage также доказывает отсутствие пропусков.

Проверить ordered overlap для реальной HTML-first ленты, opening/coalescing перекрывающихся gaps, сохранение generation и cursor. Ограничить повторный probing там, где он не даёт нового evidence; такие окна оставлять честно unresolved, а не переводить verified по факту успешного HTTP. Объединение окон должно сохранять самый ранний required cutoff и причины открытия.

Fixtures: сдвиг головы между страницами, пропажа/появление ID, sticky adverts, empty page, повторные объявления, offset ceiling, restart и capability change. Цель — измеренная полнота test corpus с меньшим числом бесполезных requests.

### P1-03. Готовый feed должен отдавать candidate сразу

Early path уже есть: `collectProgressively` → `onHotCandidates` → durable journal → dispatch. Поэтому добавление второго "fast path" без разбора существующего создаст дублирование.

Разнести p95 parsed→hot 5,22 с по feed channel/requestId и hydration. Найти ожидание поздних операций между parsing и передачей; провести контроль на одиночном feed и нескольких targets. Для полностью готового самостоятельного feed разумная экспериментальная цель parsed→candidate p95 <500 мс. Это целевой опыт, не гарантированный результат.

Early callback сейчас ждёт `dispatchListings`, который может ждать inline Telegram. Отделить durable admission от дальнейшего Telegram wait через управляемую async pipeline; не оставлять хвост только в памяти. Сохранить newest-first и backpressure. Следующий origin request и обработка уже полученного body — разные виды параллелизма: CPU/DB processing можно перекрывать, общий OLX origin owner должен оставаться согласованным.

### P1-04. Первая реакция, albums и несколько получателей

`sendListingLink` последовательно await-ит `sendListingLinkToChat` для всех recipients. Одна медленная карточка/альбом первого получателя задерживает следующего. Gate при album дополнительно начисляет время за фотографии; это защищает последующие calls от 429, но делает формат первой реакции важным.

Выделить быстрый первый signal (ссылка, цена, ключевые поля), а фото/расчёты дополнять после acceptance. Для нескольких recipients использовать независимые receipt jobs и ограниченную concurrency с общим Bot API gate. Цель — первая полезная реакция каждому, а не полный album первому за счёт остальных. Per-chat и global-bot quotas нужно моделировать раздельно; это более сложный этап, чем просто убрать 1100 мс.

Flash уже работает и подтверждает burst header раньше detail cards. Проверить предел 20 items, delayed tail 5 с, starvation между новым flash и старой detail карточкой. Tests: 1/2/20/21/100 matching items, multiple chats, заблокированный recipient, 429, timeout после принятия и crash до DB persist.

### P1-05. Метрики и canary

Сохранить `firstSeenAt` contract, добавить explicit scan/candidate event и effective access mode. Публиковать latency cohorts по source/lane/recipient/release, количество полных хронологических traces и причины incomplete.

Canary query требует несколько stage timestamps, поэтому выборка может быть маленькой/смещённой. Не повышать пороги qualification только ради promotion: сначала убедиться, что определение delay совпадает с целевой реакцией. Current request/candidate/user-device latency — разные величины.

### P1-06. Панель

Главная страница polling: monitoring 3 с, system/check 8 с, recent 5 с, metrics 10 с; shell также имеет monitoring refresh 5 с. SWR одинакового key способен переиспользовать данные, поэтому это не доказательство удвоения каждого HTTP call; интервалы всё равно ограничивают отображение свежести.

Предложение: SSE событий source scan/listing accepted/monitoring state с reconnect cursor и периодическим repair snapshot. Для видимой панели события плюс лёгкий status endpoint; metrics реже и из preaggregated/cache snapshot. Abort предыдущего client fetch при навигации, ограниченный deadline и понятный stale state. BFF сейчас буферизует response arrayBuffer — для SSE нужен отдельный streaming path, а не проксирование через существующую буферизацию.

Acceptance: вклад события в UI <500 мс в локальном измерении, reconnect не теряет записи, события не создают extra polling storm, неизвестное/stale состояние видно. Browser paint и Network waterfall в текущем аудите не измерялись.

### P1-07. Определение новизны

Strong duplicate включает source ID, canonical URL, VIN и plate. Телефон правильно не является strong key: один продавец может продавать разные машины. VIN/plate cross-source дедупликация может скрыть новое размещение той же машины с новой ценой или другим продавцом.

Если цель — каждое новое выгодное объявление, транспортную дедупликацию по source+externalId надо отделить от vehicle similarity. Совпадение VIN/plate показывать как связь, а не автоматически подавлять новое listing. Если цель — только первая карточка каждой машины, текущая семантика может быть правильной. Изменение требует этого продуктового решения; скрытых пропусков по каждому из нынешних matches не доказано.

## Остальной проект: конкретные действия

### Scheduler, replay, queues

- Replay selector использует hard-coded 5-minute backoff. Разделить свежую failed durable работу, UNKNOWN hydration и историческую re-evaluation; для известной временной причины использовать короткий bounded retry, для неизвестной — более длинный. Filter change должен иметь revision-driven re-evaluation без произвольного многоминутного ожидания, сохранив защиту от storms.
- Replay проверяет monitoring DB state на каждую карточку; заменить безопасным batched generation fence там, где это уменьшает обращения. Stop semantics должны оставаться предсказуемыми.
- BullMQ priorities действуют внутри queue, а не между отдельными queue workers. Таблица `QUEUE_PRIORITIES` сама по себе не даёт глобального CPU приоритета realtime. Origin и Telegram gate обеспечивают часть координации; добавить resource/admission budgets для фоновых DB/CPU задач.
- Hot role включает collector coverage/backfill и listing enrich. Нельзя просто вынести их в другой процесс: OLX coordinator process-local. Варианты: оставить origin owner в hot и выносить чистый CPU/analysis; либо отдельный owner с IPC, priority и fencing для всех origin requests. Второй вариант дороже и требует crash acceptance.
- Redis control уже fail-fast и не подменяется бесконечной offline queue. Hot dedupe имеет PostgreSQL fallback. Сохранять этот выигрыш; сокращать количество обращений, а не отключать ownership повсеместно.

### Collectors и normalization

- AUTO.RIA public сначала context URL, затем saved-search sentinel, затем остальные saved URLs через `Promise.all(rest.map(...))` без concurrency cap. При нескольких contexts saved URLs могут повторяться. В снимке 1060 requests/266 runs (~4/run); это соответствует нескольким поисковым URLs, а не comment "one HTML request". Дедуплицировать глобальный plan, ограничить fan-out, измерять marginal new IDs каждого URL.
- Collector wrapper AUTO.RIA и ensureSources объявляют verified newest-first, public collector явно пишет `newestFirstVerified=false` и limitation. Согласовать effective capabilities с фактическим access mode. Это влияет на честность полноты/политики stop, а не только подпись интерфейса.
- OLX HTML-first уже используется; API fallback после parser/network error сохранён, после protection блокировки второй API request не выполняется. Оптимизировать фактический активный transport, а не строить план по устаревшему предположению "JSON-first".
- Для многих filters предварительно вычислять model sets/keywords и нормализованные поля candidate один раз. Сейчас число активных filters мало, поэтому это P3: измерить 1/10/100/1000 filters на fixtures прежде чем усложнять cache invalidation.
- Цена должна сравниваться в согласованной валюте. В fallback priceOriginal отдельно проверять currency context; fixture UAH/EUR без normalized price нужен для полноты. Текущая массовая ошибка такого сравнения не доказана.

### Enrichment/OCR

- `ensureListingSellerPhone` запускается из enrichment и Telegram update. Cache не является single-flight; одновременно две операции могут не найти cache и выполнить одинаковые requests. Добавить in-flight/reusable promise или короткий distributed lookup lease по identity. Не ждать phone на первой реакции.
- Phone уже извлекается без запросов из title/description/raw. В текущем resolve external lookup только AUTO.RIA; не заявлять, что каждое OLX объявление сейчас обязательно делает отдельный phone request.
- Market research имеет cache и Redis lock. Разрешить качественную cached оценку при busy origin, объединять близкие запросы, ограничивать досканирование при достаточных comparables. Статус недостаточной выборки сохранять честным.
- `processTelegramSend` объединяет successful send с enqueue enrichment в одном try. При отказе enqueue задача отправки снова fail/retry; accepted receipt предотвращает duplicate, но это лишняя работа и ложная send-error статистика. Разделить send result и recovery enrichment.
- Vehicle/market/phone завершения создают Telegram updates. Coalesce по listing+recipient и content revision; одинаковый text/caption уже сравнивается местами, но job admission также можно сократить.
- OCR serial pipeline и timeout/reset — в background. Provider checks частично идут параллельно после VIN decode. Нужны bounded job budgets, reuse checks по VIN/plate и результат каждого provider независимо; быстрее отдавать частичный полезный результат. Производительность каждого внешнего provider здесь не benchmark-илась.

### Storage/API

- Journal batch уже использует `Promise.all` по bounded WRITE_BATCH_SIZE — не последовательная запись каждого объявления. Сравнить bulk upsert с текущими writes только при burst; stage в предыдущем snapshot p50 9 мс/p95 79 мс, поэтому удаление journal не является главным ускорением.
- Последний DB probe показывал небольшие таблицы (~30,6 MB collector_runs, ~0,81 MB notifications). Накопительные seq_scan counters не доказывают slow query. Indexes/partial indexes/pool выбирать после EXPLAIN/query duration, не по одному счётчику.
- API listings include полные модели, rawData и relations. Сделать list DTO с нужными полями; подробный listing endpoint остаётся для полной карточки. Проверить pagination и сортировку firstSeen+id при изменении/retention.
- `/metrics` выполняет много параллельных DB выборок и сериализует историю на каждом запросе. Cache/coalesce 5–10 с или incremental aggregates уменьшат shared API pool pressure; invalidation monitoring/filter changes и source freshness должны быть быстрыми.
- `/health` содержит retention counts, очереди и подробные source diagnostics. Supervisor использует несколько проверок: отделить дешёвую liveness/readiness от глубокого operational report. Не запускать дорогой агрегат для каждого контроля секундной готовности.
- Никаких DB CHECK retention в реальной таблице, хотя migration содержит три. Подготовить reconciliation на restore copy и проверить existing data. Typed shared status predicates и producer/consumer contract tests снизят риск повторения P0.

### Windows и operations

- OLX Windows helper persistent, отправляет Base64 JSON body через pipe; Node делает Buffer→Response→body чтение. Измерить helper end→IPC receive→decode→parse, размер body и память. Текущий body decode ~188 мс p50 позволяет предположить пользу меньшего copying, но выигрыш ещё не доказан.
- Standby имеет Redis lease TTL 5 с/renew 1 с; supervisor polling 3 с, failures 2, stale heartbeat 20 с, readiness failures 10. Это разные классы аварий. Измерить end-to-end failover при hung process, event-loop stall, Redis outage и killed leader на controlled fixture; сумма nominal timers не равна фактическому downtime.
- Backup/restore drills полезны для availability. Диск mirror отсутствует; фиктивная копия на том же SSD не улучшит recovery. Проверить, что backup compression/restore drills имеют низкий CPU/I/O priority и не совпадают с maintenance bursts. Перенос расписания без такого измерения не нужен.
- CLI подключает DB, но Telegram gate lazy Redis требует explicit connect и explicit disconnect. Холодная первая операция в P0 deferred из-за offline queue; финальные counts уже подтверждают успешный retry. После завершения CLI Redis sockets способны удерживать процесс. Проверить exit deadline и release resources.
- Release scripts сейчас candidate→accept после stop→start→LIVE. Старые инструкции ссылаются на отсутствующий create-release. Native shell waiting после services ready наблюдался на P0. Уточнить process ownership и readiness markers, сохранить checksummed rollback, сократить blocking administrative wait.

## Что можно убрать/сократить

1. Неизменившиеся Telegram updates и повторные lookup одного телефона.
2. Повторные saved-search requests между contexts одного AUTO.RIA run.
3. Новые recovery windows на уже учтённый незакрытый диапазон при отсутствии нового требования.
4. Repeated deep scans без progress/evidence, сохраняя unresolved work и разумный retry.
5. Raw/large fields из list payload и polling полной metrics history при каждом UI обновлении.
6. Ожидание full card/album до первой полезной реакции следующему recipient.
7. Обязательную попытку delete у заведомо слишком старого Telegram сообщения перед edit fallback; проверить типы/ограничения API.
8. Отдельный delete на каждый ID album там, где подходит batch API. Детали API и ограничения разобраны в предыдущем отчёте.
9. Смешивание accepted-send и optional enrichment failure в одной ошибке.
10. Устаревшие comments и инструкции, которые утверждают fake vehicle checks, process-local Telegram gate, один HTML запрос, бесконечный flash retry или неверный release command. Реализация каждого пути важнее comment.

## Как оценивать безопасность через основную цель

Удаление проверки — полноценное изменение поведения, которое оценивается вместе с latency, uptime и сохранностью нужных событий. Для текущего проекта:

| Механизм | Цена/влияние | Решение аудита |
|---|---|---|
| Chromium sandbox settings / challenge | пользователь подтвердил текущую конфигурацию | сохранить |
| Bearer token comparison | локальная проверка без дополнительного сетевого round trip | её удаление не обосновано текущими задержками |
| OLX origin serialization/circuit | ожидание admission p95 ~333 мс в предыдущем snapshot | искать экономию requests/processing и потом canary более быстрого admission |
| Telegram global gate | создаёт минимум интервала, особенно при albums/burst | сначала fast signal/coalescing/per-recipient scheduling, затем отдельный quota experiment |
| DB journal/accepted receipts | единицы–десятки мс обычного stage | оптимизировать batching; предотвращают утрату/repeat при crash |
| Backoff replay/cleanup | минуты до повторного действия | выбирать по типу ошибки и свежести, а не один максимум для всех |
| Release validation | время подготовки выпуска | isolate/incremental checks без остановки runtime, сохранить проверяемый rollback |

Предложение снижать cooldown или расширять concurrency должно содержать измеренный выигрыш, предел, stop condition и данные о доступности источника. Это позволяет выбрать более быстрый вариант осознанно; искусственный максимум requests/sec не равен максимуму полезных новых объявлений в Telegram.

## Критерии этапов

Рабочие экспериментальные цели, не текущие гарантии:

- AUTO.RIA public сначала стабильный effective 60 с вместо 120; дальнейшее снижение — отдельный опыт с доступностью/новизной.
- Готовый matching candidate → первая Telegram acceptance p95 ≤2 с при одиночной карточке и свободном gate.
- Parsed самостоятельного feed → candidate p95 ≤0,5 с.
- Событие accepted → отображение видимой панели ≤0,5 с локально.
- На burst — быстрый flash для всех нужных recipients; отдельный бюджет detail tail.
- Backlog не стареет бесконтрольно; причины каждого pending/unresolved видны, повторные retries дают прогресс или переходят на ожидаемый cooldown.

Для проверки: baseline на конкретном release, одно основное изменение, source/channel/recipient cohorts, минимум достаточных полных traces, 0 потерь на детерминированном crash/replay corpus, отсутствие новых duplicates на retry fixtures. "Ноль ошибок вообще" и delivery на телефон не доказываются конечной suite.

## Последовательность

1. AUTO.RIA public interval + effective capability/mode observability.
2. Recovery OLX: ordered evidence, coalescing, полезность каждого фонового прохода.
3. Точность timestamps + готовый feed handoff + быстрый первый сигнал.
4. Dashboard events/list DTO/light snapshots.
5. Recipient fairness/flash tail/notification-enrichment split.
6. Phone/market/update coalescing, replay retry classes, maintenance lifecycle.
7. Только по новым измерениям — Windows IPC, filter compilation, DB bulk/indexes, resource isolation.

Постоянный приоритет закреплён в AGENTS.md. Этот аудит не внедряет перечисленные изменения и не меняет рабочий мониторинг.

## Материалы

- [Подробный P0 и первый speed audit](P0_RETENTION_AND_SPEED_AUDIT_2026-10-12.md).
- `.runtime/audit/full-audit-20261012-1791823928512.json` — свежая latency/source/recovery выборка.
- `.runtime/audit/full-api-read-probes-20261012.json` — API timings и payload sizes.
- `.runtime/audit/p0-runtime-verification-20261012.json` — 283/283, нулевой исходный хвост и tombstones.
- `.runtime/audit/p0-deep-probe-20261012.json` — ранний DB/index/recovery/slow trace probe.
