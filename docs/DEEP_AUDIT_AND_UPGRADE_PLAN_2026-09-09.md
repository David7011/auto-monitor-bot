# Глубокий аудит Auto Monitor Bot и план следующих улучшений

Дата среза: 2026-09-09, Europe/Kyiv  
Проект: `C:\Projects\auto-monitor-bot`  
Ревизия: `362ac52` (`main`, совпадает с `origin/main`)  
Rollback: tag `pre-hotpath-audit-20260909` и branch `rollback/pre-hotpath-audit-20260909` указывают на `4ab8ef121b2bd0a5adb0e81d82f34722328ca0a3`.

## 1. Краткий итог

Проект уже построен заметно лучше обычного scraper-бота: OLX имеет отдельный быстрый контур, данные сначала фиксируются в PostgreSQL, затем передаются в очереди, дедупликация и Telegram-доставка имеют lease/receipt-защиту, backfill и recovery отделены от realtime, два hot-worker дают локальный failover, источники изолированы друг от друга, а production на HP сам восстанавливается через SYSTEM-задачи и watchdog.

Итоговая оценка текущего состояния: **7,8/10**. Это хороший production-уровень для одного ноутбука и публичных web-источников, но не «идеал»: есть одна подтверждённая конфигурационная ошибка, недостаточная доказательность p99, слабое тестовое покрытие некоторых критических orchestration-модулей и один большой эксплуатационный риск — резервные копии сейчас находятся только на том же SSD.

Главный технический вывод: **переписывание collector/scheduler на Go, C# или worker_threads сейчас не обосновано**. Event-loop hot-worker почти свободен, парсинг занимает десятки миллисекунд, а основной расход времени приходится на получение ответа OLX и разрешённую Telegram-паузу. Смена языка не исправит сетевой RTT, скорость отдачи OLX и лимит Telegram.

## 2. Что было проверено

- архитектура collector → durable journal → dedup/filter → Telegram;
- приоритеты realtime/coverage/backfill/recovery;
- защита от 403/429/CAPTCHA и изоляция источников;
- HTTP pooling, retry, ограничения размера ответа и SSRF-защита;
- схема PostgreSQL, tombstone/journal/receipt/lease-механизмы;
- BullMQ/Redis-поведение и очереди;
- live health production и рабочие процессы HP;
- p50/p95/p99 текущего OLX hot-path;
- автозапуск, watchdog, power policy, резервные копии и restore drill;
- тесты, coverage, CI, dependency audit и rollback;
- крупные и сложные модули, где высок риск регрессий;
- документация и соответствие реальной `.env` безопасным опубликованным настройкам.

Проверка была read-only: production-код и конфигурация не менялись, процессы не останавливались, секреты не читались и не выводились.

## 3. Оценка по направлениям

| Направление | Оценка | Вывод |
|---|---:|---|
| Архитектура OLX hot-path | 8,5/10 | Правильное разделение realtime и фоновых работ, early-exit, newest-first, один лидер и standby |
| Защита от пропусков | 8,3/10 | Durable journal до очереди, replay и persisted boundary сильны; абсолютную полноту публичная страница доказать не может |
| Скорость доставки | 8,0/10 | Локальный путь быстрый; доминируют сеть OLX и Telegram gate |
| Дедупликация/exactly-once | 8,2/10 | Хорошая локальная защита, но остаётся неустранимое внешнее окно неоднозначного ответа Telegram |
| Автовосстановление | 8,4/10 | Supervisor, watchdog, два hot-worker, задачи SYSTEM, свежие heartbeat |
| Наблюдаемость | 7,2/10 | Стадии hot-path уже измеряются; p99 пока статистически слаб, а config truth разошёлся с README |
| Тестирование/CI | 6,5/10 | 399 тестов проходят, но критический glue-код покрыт недостаточно и extended resilience не входит в CI |
| Безопасность | 8,0/10 | Локальные bind, ACL, Defender, зашифрованные backups, pinned Actions; BitLocker не удалось подтвердить без elevation |
| Резервирование/DR | 6,0/10 | Backup и restore drill есть, но зеркало не настроено — SSD остаётся общей точкой отказа |
| Вторичные источники | 5,5/10 | CARS_UA здоров; AUTO.RIA/AUTOMOTO ограничены семантикой, RST остановлен CAPTCHA |

## 4. Фактическое состояние production

На момент контрольного снимка:

- API, PostgreSQL 18.6 и Redis 8.8.0: `OK`;
- OLX: `ACTIVE`, проверка свежая;
- два hot-worker: один leader, один standby, лидерство согласовано;
- background worker: свежий;
- event-loop hot-worker: utilization около `0,045`, p95 delay около `34,6 мс`;
- очереди realtime/Telegram/enrichment/recovery: без failed/retry backlog;
- backfill в момент снимка: один active и два prioritized job, в своей отдельной очереди;
- CARS_UA: `ACTIVE`;
- AUTO.RIA и AUTOMOTO: `LIMITED`, но выполняют проверки;
- RST: `CAPTCHA_DETECTED`, изолирован и поставлен на длительную паузу;
- сон и гибернация автоматически отключены и от сети, и от батареи;
- основная SYSTEM-задача работает; backup, restore drill и watchdog имеют успешные результаты;
- Windows Time синхронизирован с `time.windows.com`; последний успешный sync был свежим;
- Wi-Fi подключён на 866,7 Mbps, Ethernet отключён;
- SSD здоров, свободно около 405 GB;
- Defender real-time/behavior protection включены, сигнатуры свежие;
- в журнале Windows найден один неожиданный shutdown 2026-09-08; повторяемости пока нет;
- локальный encrypted backup свежий, restore drill ранее завершился успешно;
- `BACKUP_MIRROR_PATH` не настроен.

## 5. Измеренный OLX hot-path

Для честного сравнения используется только полностью хронологическая выборка, где присутствуют все точки от начала OLX-запроса до принятия Telegram. Сейчас это **24 события**. Общие 83/113 частичных наблюдений полезны для отдельных стадий, но их нельзя смешивать с полной выборкой при сравнении end-to-end.

| Стадия | p50 | p95 | p99* | Интерпретация |
|---|---:|---:|---:|---|
| request start → headers | 1749 ms | 1872 ms | 1872 ms | Основной внешний сетевой/OLX расход |
| headers → body received | 534 ms | 1793 ms | 1793 ms | Самый заметный tail внешнего ответа |
| body → parsed | 86 ms | 125 ms | 125 ms | Быстро, CPU rewrite не нужен |
| parsed → candidate | 35 ms | 35 ms | 35 ms | Практически не bottleneck |
| candidate → journal durable | 14 ms | 350 ms | 373 ms | Хорошая медиана, но есть DB-tail для исследования |
| journal → filter complete | 14 ms | 27 ms | 32 ms | Быстро |
| filter → Telegram request | 895 ms | 1242 ms | 1243 ms | В основном сознательный single-chat rate gate |
| Telegram request → accepted | 181 ms | 337 ms | 337 ms | Нормальная внешняя API-задержка |
| request start → Telegram accepted | 3865 ms | 4235 ms | 4235 ms | Текущий полный локально измеримый путь |

\* При `n=24` p99 фактически близок к максимуму выборки и не является устойчивой оценкой хвоста. Для решений по p99 нужен минимум порядка 100–200 полных событий и желательно доверительный интервал/две сопоставимые временные выборки.

### Главный bottleneck

Первое место — `request start → body received`, то есть сеть и отдача OLX. Второе место — ожидание разрешённого Telegram-слота при burst. Telegram официально советует не превышать примерно одно сообщение в секунду в одном чате, иначе появляются 429; текущий интервал 1100 ms поэтому нельзя просто уменьшить без canary.[^1] Flash bundle — правильный способ быстро дать пользователю все ссылки, пока подробные карточки идут следом.

Парсинг, фильтр, Redis и средняя работа PostgreSQL сейчас не ограничивают скорость. Node 24 уже предоставляет монотонные high-resolution timestamps, event-loop utilization и delay histograms, поэтому наблюдаемость можно усилить без смены языка.[^2]

## 6. Подтверждённые проблемы

### P0/P1-1. Расхождение конфигурации canary и документации — ИСПРАВЛЕНО 2026-09-09

README и новые defaults говорят `18±3 с`, но production `.env` явно задаёт `15±3 с`. Новый `OLX_CADENCE_CANARY_HOT_PATH_MIN_SAMPLES` отсутствует в `.env`, а `scripts/runtime-docs.mjs` не содержит эту настройку и всё ещё описывает переход `20±4 → 15±3`.

Следствие: `amb.cmd check` сейчас останавливается на `docs:check` с сообщением, что README runtime configuration устарела. Production безопасен только потому, что canary уже автоматически откатился на baseline `20±4 с`. При следующем допуске он снова попробует более резкий вариант `15±3 с`, а не заявленный осторожный `18±3 с`.

Исправление выполнено: production override приведён к `18±3 с`, минимальная выборка явно установлена в `30`, описание перехода теперь вычисляется из проверенных значений, а генератор запрещает пропуск любого нового `OLX_CADENCE_CANARY_*` из безопасной документации. После изменения прошли полный quality-gate, 399 тестов, production build, dependency audit и extended resilience acceptance. Создана свежая зашифрованная копия БД, выполнен контролируемый SYSTEM-restart. Новый API-процесс подтвердил `20±4 → 18±3`, `24/30` samples и сохранённый безопасный режим `ROLLED_BACK`; OLX, PostgreSQL, Redis, два hot-worker и очереди после restart здоровы.

### P1-2. Canary принял решение на слишком маленьком latency-tail sample

Canary правильно откатился: прежний `15±3 с` дал p95 `4974 ms`, что превысило лимит роста `4631 ms`. Но его `P95_MIN_SAMPLES=10` слишком мал для устойчивого сравнения хвоста. Ошибки/403/429/CAPTCHA должны по-прежнему откатывать немедленно; latency-регрессию разумнее оценивать после 30+ canary runs, а p99 — после 100–200 полных traces.

Дополнительно одновременно существуют cadence-canary и origin quiet-canary (`350 → 150 ms`). Если оба меняют режим в одном окне, причинность ухудшения становится неясной. Эксперименты нужно сериализовать и маркировать `experimentId + commit + effective config`.

### P1-3. Критический glue-код недостаточно покрыт тестами

Все 399 unit-тестов проходят, production dependency audit чист. Однако суммарное statement/line coverage около `40,47%`, а самые опасные side-effect/orchestration-модули покрыты слабо:

- `collector-run.ts` — 0%;
- `listing-detected.ts` — около 4,6%;
- `observation-replay.ts`, `listing-enrich.ts`, API `server.ts` — 0%;
- cadence canary orchestration — около 8% при хорошем покрытии чистой policy;
- Telegram control bot/status и значительная часть API routes — низкое покрытие;
- OLX collector — около 55%, при этом `olx-feed` и request coordinator покрыты заметно лучше.

CI проверяет Windows quality, migrations, dashboard E2E и CodeQL, но не запускает полный `acceptance:extended`, worker pipeline E2E, failover hot-worker и crash/replay matrix. Риск здесь не в алгоритмах, а в соединяющем их коде.

### P1-4. Резервные копии имеют общую точку отказа с production

Backup шифруется с authenticated AES-256-GCM, проверяется через `pg_restore --list`, хранится 14 дней, а отдельная задача выполняет restore drill. Это сильная реализация. Но `BACKUP_MIRROR_PATH` пуст: production БД и все автоматические копии находятся на одном SSD. Поломка/кража ноутбука или шифрование диска уничтожит обе стороны. CISA рекомендует offline/off-device encrypted backups и регулярные проверки восстановления.[^3]

### P1-5. BitLocker не подтверждён

Read-only запрос статуса получил отказ без административных прав. Это не доказывает, что шифрование выключено, но оставляет контроль незавершённым. На мобильном ноутбуке потеря устройства — реальная угроза секретам и базе; BitLocker предназначен именно для защиты offline-data при краже/изъятии диска.[^4]

### P1-6. Точность telemetry можно усилить

Durable timestamps сейчас нужны для корреляции между процессами, но wall clock может прыгнуть при коррекции времени. Следует сохранять одновременно:

- UTC wall-clock timestamp для корреляции;
- monotonic duration для стадий внутри одного процесса;
- trace/experiment ID;
- effective config hash;
- source request ID и delivery attempt ID.

Windows Time сейчас синхронизирован, но root dispersion около 5,25 s показывает, что абсолютное время публикации нельзя трактовать как миллисекундную истину. `publication → detection` дополнительно искажается тем, когда OLX реально выставил объявление в публичном поиске. Microsoft называет `w32tm` штатным средством диагностики W32Time.[^5]

### P1-7. DB-tail требует наблюдения, но не преждевременной оптимизации

`candidate → durable journal` имеет p50 14 ms и p95 350 ms. Это не повод увеличивать pool или объединять запросы вслепую: pool сейчас не имеет waiters. Сначала нужны spans по конкретным SQL и lock-wait. `pg_stat_statements` хорошо агрегирует planning/execution, но требует preload и restart; включать его надо отдельным maintenance-шагом.[^6] `auto_explain ANALYZE` может создать заметный overhead, особенно с node timing, поэтому его нельзя бездумно включать в production.[^7]

### P1-8. Семантика «сильного дубликата» нуждается в разделении

`source + externalId` и canonical URL однозначно обозначают одно marketplace-объявление. VIN/номер обозначают физическую машину. Повторная публикация той же машины или та же машина на другом сайте может быть полезным новым событием, но глобальный strong duplicate способен погасить уведомление.

Нужно разделить два понятия:

1. `same listing` — безопасно подавлять;
2. `same vehicle` — связывать/помечать как возможный дубль, но не всегда подавлять первое уведомление.

До изменения нужны реальные примеры из журнала и явное продуктовое правило.

### P2-1. Неограниченный рост durable tombstones/history

Тяжёлые карточки очищаются, а `SourceSeenListing` сохраняет proof состояния — это правильно для отсутствия повторов. Но постоянные tombstones, recovery windows и telemetry со временем увеличат индексы, backup/restore и VACUUM-нагрузку. Нельзя просто удалять их: сначала нужен прогноз роста на 30/90/365 дней, размер индексов и безопасная схема partition/archive/compact hash.

### P2-2. Логи приложений не имеют единой доказанной политики rotation

Supervisor и watchdog ротируют собственные логи примерно по 5 MB. Основные `api/worker/dashboard/postgres/redis` файлы сейчас малы, но общей политики для всех файлов не видно. Долговременный сетевой сбой или stack-trace storm способен заполнить SSD. Нужны общий размерной cap, количество поколений, disk-free alarm и тест rotation.

### P2-3. Фильтр кэшируется до двух секунд

`FILTER_CACHE_MS=2000` не замедляет обнаружение при неизменной подписке, но после изменения фильтра до двух секунд действует старая версия. Если редактирование подписок частое, лучше инвалидировать кэш событием/version counter; polling cache оставить fallback.

### P2-4. Не все failure windows доказаны E2E

Нужно отдельно воспроизвести:

- crash после durable journal, но до Redis enqueue;
- crash после Redis claim, но до filter/send;
- Telegram принял запрос, но процесс упал до записи receipt;
- Redis отсутствует 1–5 минут, PostgreSQL жив;
- PostgreSQL перезапущен во время active pass;
- лидер hot-worker умер во время OLX response body;
- фильтр изменён во время burst;
- ноутбук перезагружен Windows Update.

BullMQ прямо рекомендует проектировать jobs идемпотентными и атомарными, чтобы retries не меняли итоговый результат.[^8] Проект следует этому принципу, но именно crash-matrix должна доказать реализацию целиком.

### P2-5. Большие модули повышают стоимость безопасных изменений

Крупнейшие файлы (`olx.ts` ~1095 строк, `source-search-plan.ts` ~927, orchestrator ~762, `telegram-service.ts` ~739) пока работают, поэтому rewrite не нужен. Но стоит выделить чистые seams: mapping/normalization, state transition policy, persistence adapter, delivery policy. Цель — тестируемость и меньший blast radius, а не новый framework.

## 7. Что уже сделано правильно и не надо ломать

- один newest-first realtime page и ранняя обработка кандидатов;
- OLX leader/standby вместо двух одновременных producer;
- durable PostgreSQL journal до Redis handoff;
- recovery/replay, persisted boundary и `UNRESOLVED` вместо бесконечного deep scan;
- preemptible backfill и отдельные очереди;
- coalescing похожих запросов внутри рабочего контура;
- origin coordinator с приоритетами и circuit breaker;
- строгая классификация challenge/429 и отсутствие request storm;
- flash-first Telegram bundle при burst;
- локальные bind, response-size cap и SSRF-защита;
- pinned Node/pnpm/PostgreSQL/Redis и frozen lockfile;
- SHA-pinned GitHub Actions — GitHub считает полный commit SHA единственным immutable способом закрепить action.[^9]
- encrypted backup, hash metadata и restore drill;
- rollback branch/tag до hot-path изменений.

## 8. Что не внедрять сейчас

| Идея | Решение | Причина |
|---|---|---|
| Перенос collector/scheduler на Go/C# | Не делать | CPU/event-loop не bottleneck; сеть OLX останется той же |
| `worker_threads` для HTML parse | Не делать | parse p95 125 ms, event-loop свободен |
| Три OLX-страницы параллельно | Не делать | realtime нужен только newest page; рост запросов повышает challenge risk |
| Уменьшить Telegram gate ниже 1 s | Не делать | противоречит официальной рекомендации и увеличивает 429[^1] |
| Сразу поставить polling 10–15 s | Не делать | прежний 15±3 canary уже ухудшил p95 и был откатан |
| CAPTCHA-solving/bypass | Не делать | риск аккаунта/сети, нестабильность и нарушение защит; источник должен оставаться изолированным |
| ETag как обязательное ускорение | Только после наблюдения | помогает лишь если OLX реально выдаёт стабильный validator; 304 не гарантирован |
| Увеличить DB pool | Не делать без waiters | текущий pool свободен; больше соединений могут ухудшить contention |
| Обещать «не пропустить вообще всё» | Нельзя честно обещать | публичный поиск не даёт транзакционный event feed и может индексировать/скрывать объявления между polling |

## 9. Поэтапный план апгрейдов

### Этап 1 — восстановить единый config truth и зелёный gate (P0, первым)

Действия:

1. Добавить `OLX_CADENCE_CANARY_HOT_PATH_MIN_SAMPLES` в генератор runtime docs.
2. Исправить описание `15±3` на `18±3` в едином источнике.
3. Синхронизировать README через штатный генератор.
4. Явно привести production `.env` к `18±3` и зафиксировать sample minimum.
5. Запустить полный `amb.cmd check`, production audit и extended acceptance.
6. Выполнить контролируемый restart, затем `local:status` и fresh OLX pass.

Критерий: docs check зелёный; безопасный runtime whitelist показывает ровно ожидаемые значения; OLX и очереди здоровы.  
Rollback: вернуть только четыре canary-параметра и предыдущую ревизию; baseline `20±4` остаётся рабочим.

### Этап 2 — сделать telemetry статистически доказательной (P0/P1)

Действия:

- накапливать не менее 100 полных chronological traces до решений по p99;
- хранить monotonic durations вместе с UTC timestamps;
- добавить exact `--since/--until`, config hash, commit и experiment ID;
- отделить `source published timestamp`, `first publicly observed` и внутренний request latency;
- показывать confidence/sample warning, если n мало;
- сериализовать cadence и quiet canary: меняется только один параметр за эксперимент.

Критерий: любой BEFORE/AFTER воспроизводим по immutable JSON и одинаковому временному окну.  
Rollback: telemetry-поля additive; отключение нового writer не меняет pipeline.

### Этап 3 — осторожный canary `20±4 → 18±3` (P1)

Допускать только после стабильного baseline и достаточных complete traces.

Мгновенный rollback при любом новом 403/429/CAPTCHA, circuit-open, failed backlog, потере boundary либо hard latency >12 s. Latency promotion — только после достаточной выборки, не после десяти наблюдений.

Критерий успеха:

- challenge/rate-limit rate не вырос;
- OLX pass p95 и request→Telegram p95 не хуже baseline более согласованного процента;
- нет дубликатов и пропусков в bounded parity sample;
- CPU/event-loop/DB waits остаются здоровыми.

Rollback: автоматический возврат `20±4`; состояние и причина сохраняются durable.

### Этап 4 — локализовать DB-tail (P1)

Сначала добавить application spans вокруг конкретных journal/dedup/filter запросов. Затем в maintenance window рассмотреть `pg_stat_statements` с консервативными настройками. Не включать `auto_explain ANALYZE + timing` постоянно.

Оптимизировать только запрос, который доказан в p95/p99: индекс, один `INSERT ... ON CONFLICT ... RETURNING`, либо короткая транзакция. Не объединять сетевой Telegram call с DB transaction.

Критерий: `candidate → journal` p95 устойчиво ниже 100 ms без роста lock waits/WAL.  
Rollback: удалить новый индекс/вернуть query path через обратимую миграцию и feature flag.

### Этап 5 — закрыть crash/replay/notification matrix в CI (P1)

Добавить hermetic tests для перечисленных failure windows, worker pipeline E2E и hot-leader failover. Включить `acceptance:extended` в обязательный CI job или разделить на быстрый PR gate и nightly/Windows resilience gate. Ввести coverage thresholds не по общему проценту, а по критическим модулям.

Критерий: каждый crash point доказывает `0 пропусков`, `0 подтверждённых дублей`, bounded recovery time.  
Rollback: тесты не затрагивают production; нестабильный тест сначала quarantine с причиной, но не удалять сценарий.

### Этап 6 — независимая копия и независимый dead-man monitor (P1)

Настроить encrypted mirror на другой физический носитель/UNC/off-device storage, не на `C:`. Секрет шифрования хранить отдельно. Продолжать еженедельный restore drill и добавить квартальную проверку восстановления «с нуля».

Поскольку один ноутбук не способен уведомить о собственной полной потере питания/интернета, нужен внешний heartbeat monitor, который подаст сигнал при отсутствии HP. Он не должен быть вторым producer.

Критерий: потеря SSD не уничтожает последнюю проверенную копию; отсутствие heartbeat обнаруживается вне HP.  
Rollback: отключить mirror/monitor, локальный backup продолжает работать.

### Этап 7 — identity/dedup semantics (P1/P2)

Разделить listing identity и vehicle identity, прогнать историю в shadow-mode и посчитать, сколько полезных re-list/cross-source событий подавлялось бы каждым правилом. Только затем менять suppression.

Критерий: ноль повторных Telegram-сообщений об одном listing и отсутствие потери новых re-list событий.  
Rollback: feature flag возвращает текущую strong-dedup policy.

### Этап 8 — capacity и retention (P2)

Добавить метрики размера таблиц/индексов, WAL, backup duration, restore duration, log directory size и free disk. Через 30 дней построить прогноз; лишь затем решать partition/archive.

Критерий: рассчитанный запас SSD >12 месяцев, backup/restore укладываются в SLO, disk alert срабатывает заранее.  
Rollback: метрики read-only; schema changes только отдельной миграцией.

### Этап 9 — аккуратная декомпозиция больших файлов (P2)

Извлекать по одному чистому модулю с characterization tests, не меняя runtime behavior. После каждого шага benchmark и полный gate. Начать с OLX normalization и canary state transition, а не с transport/process model.

Критерий: идентичные результаты fixtures и не хуже p95; уменьшение cyclomatic/change surface.  
Rollback: один маленький commit на seam, легко revert без отката данных.

### Этап 10 — вторичные источники и multi-category (P2/P3)

После стабилизации OLX:

- для RST искать официальный/разрешённый feed или партнёрский доступ, CAPTCHA не обходить;
- AUTO.RIA/AUTOMOTO честно маркировать как limited freshness без точного timestamp;
- закончить live-проверки laptop/other categories, scoped query, STRICT detail lifecycle, shard backpressure и parser fixtures;
- вторичные источники никогда не должны менять SLO OLX.

## 10. Целевые SLO после этапов 1–5

| Метрика | Цель |
|---|---:|
| OLX request start → Telegram accepted p50 | ≤ 4,0 s |
| OLX request start → Telegram accepted p95 | ≤ 5,0 s |
| OLX parser p95 | ≤ 200 ms |
| candidate → durable journal p95 | ≤ 100 ms после доказанной DB-оптимизации |
| failed/retry backlog realtime | 0 в steady state |
| confirmed duplicate notifications | 0 |
| journaled eligible observations lost | 0 |
| challenge/403/429 increase during canary | 0 допустимого роста |
| hot-worker failover | bounded и автоматически проверяемый |
| backup restore drill | 100% успешных запусков |

`publication timestamp → notification` нельзя использовать как единственный speed SLO: OLX может опубликовать timestamp раньше фактического попадания в публичный поиск. Для внутренней инженерной скорости правильный SLO — от нашего request start/first public observation до Telegram acceptance.

## 11. Приоритет ближайших работ

1. ~~**Исправить config/docs drift и вернуть полностью зелёный gate.**~~ Выполнено 2026-09-09.
2. **Дособрать ≥100 complete traces и усилить методику canary.**
3. **Провести canary только `18±3`, меняя одну переменную.**
4. **Разобрать DB-tail application spans; не оптимизировать вслепую.**
5. **Добавить crash/replay/worker E2E в CI.**
6. **Создать независимую encrypted backup-копию и внешний dead-man monitor.**
7. **Уточнить listing-vs-vehicle dedup semantics.**
8. Затем — retention capacity, log caps, seam extraction и вторичные источники.

## 12. Финальный вердикт

Проект уже быстр и устойчив в своём локальном critical path. Его следующий качественный скачок даст не новый язык и не агрессивный polling, а устранение config drift, более строгая экспериментальная методика, доказанные crash-тесты, точечное устранение DB-tail и защита от потери единственного ноутбука/SSD.

Текущий production можно оставлять работающим на baseline `20±4 с`: OLX здоров, автоматический rollback сработал, очереди не забиты. Но называть систему «идеальной» до прохождения этапов 1–6 нельзя.

## Источники

[^1]: Telegram, “Bots FAQ — Broadcasting to Users”: рекомендация не превышать примерно одно сообщение в секунду в одном чате. https://core.telegram.org/bots/faq
[^2]: Node.js 24, “Performance measurement APIs”: `performance.now()`, Event Loop Utilization и event-loop delay histograms. https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html
[^3]: CISA, “#StopRansomware Guide”: offline/encrypted backups и регулярная проверка восстановления. https://www.cisa.gov/stopransomware/ransomware-guide
[^4]: Microsoft, “Encryption and data protection”: BitLocker защищает данные от offline-доступа при потере или краже устройства. https://learn.microsoft.com/en-us/windows/security/book/operating-system-security-encryption-and-data-protection
[^5]: Microsoft, “Windows Time Service Tools and Settings”: `w32tm` как штатный инструмент мониторинга и диагностики W32Time. https://learn.microsoft.com/en-us/windows-server/networking/windows-time-service/windows-time-service-tools-and-settings
[^6]: PostgreSQL 18, “pg_stat_statements”: агрегированная статистика planning/execution и требование `shared_preload_libraries`/restart. https://www.postgresql.org/docs/18/pgstatstatements.html
[^7]: PostgreSQL 18, “auto_explain”: предупреждение о значительном overhead `log_analyze` и per-node timing. https://www.postgresql.org/docs/18/auto-explain.html
[^8]: BullMQ, “Idempotent jobs”: jobs должны быть идемпотентными и максимально атомарными для безопасных retries. https://docs.bullmq.io/patterns/idempotent-jobs
[^9]: GitHub, “Secure use reference”: полный commit SHA — immutable способ закрепить Action. https://docs.github.com/en/actions/reference/security/secure-use
