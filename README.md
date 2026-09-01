# Auto Monitor Bot

Локальная система непрерывного мониторинга автомобильных объявлений с приоритетом OLX. Проект собирает объявления, сохраняет исходные наблюдения до фильтрации, устраняет дубли, применяет пользовательские фильтры и как можно раньше отправляет первое сообщение в Telegram. Более тяжёлые проверки рынка, VIN и номера выполняются после первой отправки и обновляют уже созданное сообщение.

Проект работает только на этом ноутбуке. Публичный сервер не требуется: `SYSTEM`-супервизор запускается вместе с Windows, сразу активирует API, изолированные hot/background workers, Dashboard и мониторинг, а затем точечно восстанавливает упавшие локальные процессы. `local:stop` останавливает текущую сессию без restart-loop; следующий boot/logon снова запускает проект автоматически.

## Состав

- `apps/api` — Fastify API, планировщик, управление мониторингом, health и метрики.
- `apps/worker` — изолированные BullMQ-роли: два процесса `worker-hot-a/b` работают как active/standby. Redis lease допускает только одного активного consumer, а второй автоматически принимает realtime-очереди после отказа лидера; так сохраняются единые OLX pacing и Telegram gate. `worker-background` отдельно выполняет replay, тяжёлые vehicle/OCR checks и обслуживание.
- `apps/dashboard` — локальная Next.js панель с same-origin BFF.
- `apps/mobile-android` — Android-пульт для приватного доступа через Tailscale.
- `packages/db` — Prisma и PostgreSQL.
- `packages/shared` — общие типы, справочники и фильтрация.
- `.runtime` — локальные БД, Redis, Node, браузеры, логи и зашифрованные бэкапы; каталог не попадает в Git.

## Быстрый запуск

Проект использует собственные закреплённые Node.js 24.18.0 и pnpm 10.0.0. Глобальный Node не нужен.

```powershell
cd D:\auto-monitor-bot
.\amb.cmd local:start
.\amb.cmd local:status
```

Адреса:

```text
Dashboard: http://127.0.0.1:3001
API:       http://127.0.0.1:4000
Health:    http://127.0.0.1:4000/health
```

Остановка и перезапуск:

```powershell
.\amb.cmd local:stop
.\amb.cmd local:restart
```

После установки автозапуска проект включается автоматически при загрузке Windows или входе пользователя. `local:stop` останавливает текущую сессию без restart-loop; `local:start` запускает её снова вручную. При следующей загрузке Windows supervisor автоматически создаёт новое разрешение и сразу восстанавливает PostgreSQL, Redis, API, оба worker-процесса и Dashboard.

После запуска метрики холодного старта сохраняются в `.runtime/startup-metrics.json`. API `/metrics` отдельно показывает время до первого успешного OLX-прохода, стартовый catch-up и обычный steady-state, чтобы результаты восстановления после простоя не искажали реальную скорость мониторинга.

## Автозапуск Windows

```powershell
.\amb.cmd autostart:install
```

Создаются четыре задачи Планировщика Windows:

- `Auto Monitor Bot` — долгоживущий supervisor с триггерами boot и logon. При старте задачи он активирует проект и поднимает PostgreSQL, Redis, API, `worker-hot-a`, `worker-hot-b`, `worker-background` и Dashboard. У каждого процесса отдельный heartbeat с event-loop telemetry; `/health` дополнительно проверяет согласованность hot-leader lease. Утрата одного hot-процесса не останавливает второй, а supervisor адресно восстанавливает утраченную резервную копию.
- `Auto Monitor Bot Watchdog` — проверяет PID, порты и локальную инфраструктуру активной сессии. После намеренного `local:stop` проверки отключаются до следующей загрузки Windows, запуска задачи или ручного `local:start`, поэтому остановка не превращается в restart-loop.
- `Auto Monitor Bot Database Backup` — ежедневный проверяемый бэкап PostgreSQL в 03:15.
- `Auto Monitor Bot Database Restore Drill` — каждое воскресенье восстанавливает последний backup во временную БД, проверяет структуру/данные и удаляет временную БД.

Все задачи работают от `SYSTEM` с наивысшими правами. Перед установкой и перед каждым фактическим запуском task launcher выполняет fail-closed ACL-проверку: исполняемый проект разрешено изменять только `SYSTEM`, `Administrators` и доверенному владельцу проекта. Изменённый action, лишний writable SID, небезопасный владелец, reparse point или включённое наследование на защищённой границе блокируют elevated-запуск.

Локальный PostgreSQL запускается с `shared_buffers=32MB` и `max_connections=50`. Для трёх долгоживущих процессов БД используется по одному ограниченному пулу максимум на 6 соединений; idle-соединения сохраняются до остановки процесса, чтобы не платить за повторный Windows backend/handshake на первом новом объявлении. Только транзиентный сбой создания соединения повторяется два раза через 25/75 мс; ошибки авторизации, SQL и целостности не повторяются и остаются видимыми. Диагностика пула и счётчики восстановленных/исчерпанных повторов доступны в `GET /health -> database.pool`.

Первичное усиление или повторное устранение дрейфа ACL запускается из elevated PowerShell:

```powershell
.\amb.cmd security:harden
.\amb.cmd security:check
```

`security:harden` сначала сохраняет исходный root ACL вне проекта в `D:\AutoMonitorBotSecurityBackups`, применяет точный DACL через штатный `icacls`, сбрасывает дочерние ACL и владельцев, а затем отдельно изолирует `.env`, `scripts` и `.runtime\security`. `security:check` также входит в полный `check`.

Удаление задач:

```powershell
.\amb.cmd autostart:remove
```

## Как обеспечивается скорость OLX

- В здоровом режиме LIVE-интервал OLX — `20 ± 4` секунды вместо прежних `60 ± 10`: измеренный p95 полного realtime-прохода 17,45 с, поэтому новый cadence втрое сокращает окно обнаружения и обычно не накладывает проходы друг на друга. После защитного инцидента скорость возвращается ступенчато `60 → 30 → 20` секунд за 30 минут; неразрешённый инцидент остаётся на 60 секундах.
- Публичная newest-first HTML-выдача является основным каналом. Внутренний `/api/v1/offers` используется только как аварийный резерв после технической ошибки HTML, но никогда не вызывается следом за `403`/CAPTCHA.
- Каждую минуту выполняются независимые региональная и HTML-сверки, а каждые 90 секунд — owner/private shadow-feed. Их расписание хранится отдельно для каждого поискового fingerprint.
- Каждый завершившийся direct HTML-ответ по городу или региону передаёт кандидатов в обработку немедленно, не ожидая остальные direct targets и более медленные private/региональные сверки. Полный результат прохода затем сохраняет их общим транзакционным путём без повторной отправки.
- Все OLX-запросы проходят через единый приоритетный координатор. На origin одновременно выполняется не более одного запроса; realtime не только выбирается раньше очереди recovery/coverage/backfill/enrichment, но и отменяет уже выполняющийся фоновый HTTP GET или DNS-retry delay. Прерванная фоновая операция прозрачно возвращается в очередь и продолжается после realtime, не превращаясь в `TIMEOUT` и не создавая разрыв coverage. Ответ `429`/CAPTCHA/access denied всегда открывает защитный circuit даже при одновременной отмене. После запроса выдерживается 350 мс, а фон дополнительно разнесён минимум на 3500 мс.
- Private/региональные каналы используют те же публичные HTML-страницы, уступают realtime и автоматически ставятся на паузу при rate limit/CAPTCHA.
- География нескольких фильтров объединяется без сужения: вся Украина имеет приоритет над регионами, регион — над отдельными городами. Поэтому смешанный набор фильтров больше не может случайно сузить общий OLX-поиск и создать невидимое окно.
- Realtime-проход читает только первую newest-first страницу (`OLX_REALTIME_MAX_PAGES=1`), чтобы глубокая сверка не удерживала следующий hot-цикл. Если первая страница не пересеклась с известным хвостом, система немедленно ставит прерываемый recovery в отдельную очередь и восстанавливает глубину до сохранённой границы.
- Граница overlap считается достоверной только для полностью известной выдачи либо непрерывного известного хвоста.
- Если лимит кандидатов исчерпан, проход не объявляется завершённым ошибочно.
- Независимый backfill работает адаптивно: после разрыва или найденного пропуска выполняет глубокий проход до 20 страниц, после чистой серии переходит на лёгкую проверку и сохраняет полный шестичасовой аудит. Между двумя завершениями realtime ему разрешена не более чем одна глубокая страница.
- Rate limit глубокой backfill-страницы останавливает только этот backfill и включает безопасный облегчённый probe; здоровый realtime-источник OLX больше не переводится из-за него в общую паузу.
- Повторный OLX HTTP 403 включает отдельное восстановительное окно 6, затем 12 и максимум 24 часа без контрольных запросов; обычный HTTP 429 по-прежнему учитывает `Retry-After`. После единственного успешного probe cadence не прыгает сразу на максимум, а проходит защитную лестницу восстановления.
- `lastCompletedCutoff` обновляется только после доказанного достижения временной границы.
- Все нормализованные кандидаты сохраняются в журнал наблюдений PostgreSQL до короткого Redis-claim. Даже падение hot-worker в первой инструкции обработки оставляет объявление наблюдаемым и доступным для replay; claim имеет owner token, освобождается compare-delete и живёт не более 120 секунд.
- Для каждого нового OLX-наблюдения сохраняются первый и последний канал (`public HTML`, региональная/private HTML-сверка или аварийный API fallback) и безопасная метка области поиска. В «Планировщике» показываются реальные p50/p95 задержки по каналам за 24 часа.
- Queue consumers подтверждают готовность до startup recovery, replay и обновления курса; эти фоновые задачи откладываются на секунду и не блокируют первый OLX realtime.
- Найденные кандидаты обрабатываются параллельно с ограничением `FAST_INLINE_LISTING_CONCURRENCY=4`; внутри одного lane Telegram выбирает карточки по времени публикации — самая свежая получает следующий слот. Начала всех изменяющих Telegram-запросов (`sendMessage`, edit и delete) в один чат глобально разнесены на `TELEGRAM_LISTING_SEND_MIN_INTERVAL_MS=1100`. API, обе hot-реплики, background worker и watchdog резервируют атомарные слоты в одном Redis gate по паре bot/chat, поэтому отдельный процесс больше не может создать параллельный залп.
- Глобальный gate использует серверное `Redis TIME`, распространяет Telegram `retry_after` на все процессы и не содержит bot token в Redis-ключе. Обычные API/worker-операции при недоступном Redis закрываются безопасно; только однопроцессный watchdog может отправить аварийное сообщение без gate, если причиной аварии является сам Redis.
- Первое Telegram-сообщение сохраняется и отправляется до фонового enrichment. После `FAST_INLINE_TELEGRAM_DEADLINE_MS=4000` неоднозначный сетевой запрос не дублируется: он остаётся in-flight, а резервная задача ждёт истечения DB lease. Ошибка постановки enrichment больше не запускает повторную отправку Telegram.

Это максимально быстрый безопасный режим для публичного интерфейса OLX, но абсолютную гарантию «ни одного пропуска» внешний сайт без официального стабильного event API дать не может. CAPTCHA, rate limit, изменение формата выдачи, сетевой сбой и предел публичной пагинации являются внешними ограничениями. Система явно показывает такие случаи, использует `Retry-After`, экспоненциальную паузу и глубокий повторный проход вместо агрессивных запросов, повышающих риск блокировки.

## Хранение найденных объявлений

- Обычная карточка хранится 12 часов и затем удаляется из Telegram и базы при ближайшей пятиминутной проверке.
- Кнопка `🤍 Сохранить на 10 дней` переключает карточку в избранное; повторное нажатие снимает сохранение.
- После удаления тяжёлых данных постоянно остаётся только компактная запись `source + externalId`, поэтому прежнее объявление не отправляется повторно даже после истечения общего срока журнала.
- Лёгкий OLX-кэш ID при достижении ровно 2000 записей атомарно очищается до нуля. Перед сбросом сохраняются 50 continuity anchors, а журнал наблюдений запускает перекрывающий recovery-проход; Telegram-избранное хранится отдельно и этим сбросом не затрагивается. Поведение проверяется транзакционным тестом на реальной PostgreSQL.
- Нажатие кнопки избранного и фоновая очистка сериализованы advisory-lock по карточке. Очиститель больше не может удалить сообщение между проверкой и сохранением в избранное.
- Telegram Bot API разрешает физически удалять обычные сообщения только в первые 48 часов. Поэтому 10-дневная избранная карточка в срок очищается до короткой служебной строки без ссылки и кнопок, а данные проекта удаляются полностью.
- Предварительный просмотр очистки: `pnpm maintenance:listings`. Применение: `pnpm maintenance:listings -- --apply`.

Параметры: `LISTING_RETENTION_HOURS`, `LISTING_FAVORITE_RETENTION_DAYS`, `LISTING_CLEANUP_INTERVAL_MS`, `LISTING_CLEANUP_BATCH_SIZE`.

Основные параметры:

<!-- runtime-config:start -->
Этот блок генерируется из `.env.example`; `pnpm docs:check` также сверяет значения с fallback-настройками API и worker.

| Группа | Параметр | Значение | Назначение |
|---|---|---:|---|
| OLX realtime | `LIVE_OLX_INTERVAL_SECONDS` | `20` | Интервал быстрого OLX-прохода |
| OLX realtime | `LIVE_OLX_JITTER_SECONDS` | `4` | Случайный разброс быстрого прохода |
| OLX canary | `OLX_CADENCE_CANARY_ENABLED` | `true` | Автоматический переход 20±4 → 15±3 |
| OLX canary | `OLX_CADENCE_CANARY_QUALIFICATION_RUNS` | `100` | Чистых baseline-проходов до canary |
| OLX canary | `OLX_CADENCE_CANARY_PROMOTION_RUNS` | `100` | Чистых canary-проходов до promotion |
| OLX canary | `OLX_CADENCE_CANARY_INTERVAL_SECONDS` | `15` | Интервал экспериментального realtime |
| OLX canary | `OLX_CADENCE_CANARY_JITTER_SECONDS` | `3` | Jitter экспериментального realtime |
| OLX canary | `OLX_CADENCE_CANARY_QUALIFICATION_MAX_P95_MS` | `8000` | Максимальный baseline p95 для допуска |
| OLX canary | `OLX_CADENCE_CANARY_MAX_P95_MS` | `12000` | Жёсткий latency rollback-порог |
| OLX canary | `OLX_CADENCE_CANARY_P95_MIN_SAMPLES` | `10` | Минимальная canary-выборка для p95 |
| OLX canary | `OLX_CADENCE_CANARY_P95_GROWTH_PERCENT` | `125` | Допустимый рост p95 к baseline, процентов |
| OLX canary | `OLX_CADENCE_CANARY_QUEUE_DEPTH_LIMIT` | `25` | Максимальная hot-queue глубина |
| OLX realtime | `OLX_REALTIME_RECOVERY_RAMP_SECONDS` | `1800` | Плавный возврат скорости после защиты |
| OLX origin | `OLX_REALTIME_QUIET_CANARY_ENABLED` | `true` | Безопасный canary post-finish паузы 350 → 150 мс |
| OLX origin | `OLX_REALTIME_QUIET_CANARY_CANDIDATE_MS` | `150` | Canary-пауза между последовательными realtime запросами |
| OLX origin | `OLX_REALTIME_QUIET_CANARY_QUALIFICATION_REQUESTS` | `100` | Чистых origin-запросов до canary |
| OLX origin | `OLX_REALTIME_QUIET_CANARY_EVALUATION_REQUESTS` | `30` | Canary-запросов до promotion |
| OLX origin | `OLX_REALTIME_QUIET_CANARY_P95_GROWTH_PERCENT` | `120` | Максимальный p95 относительно baseline, процентов |
| OLX origin | `OLX_REALTIME_QUIET_CANARY_QUEUE_DEPTH_LIMIT` | `25` | Очередь realtime для мгновенного rollback |
| OLX полнота | `OLX_API_PAGE_SIZE` | `50` | Размер страницы публичного API |
| OLX полнота | `OLX_KNOWN_IDS_RESET_THRESHOLD` | `2000` | Порог полного сброса лёгкого кэша OLX ID |
| OLX полнота | `OLX_REALTIME_MAX_PAGES` | `1` | Максимум realtime-страниц |
| OLX полнота | `OLX_BACKFILL_MAX_PAGES` | `20` | Максимум страниц глубокой сверки |
| OLX полнота | `OLX_COVERAGE_INTERVAL_SECONDS` | `60` | Интервал durable regional/HTML/private сверки |
| OLX полнота | `OLX_COVERAGE_INITIAL_DELAY_SECONDS` | `30` | Задержка coverage после старта realtime |
| OLX полнота | `OLX_COVERAGE_MAX_DURATION_MS` | `30000` | Жёсткий бюджет одного coverage run |
| OLX полнота | `WORKER_CONCURRENCY_COLLECTOR_COVERAGE` | `1` | Параллельность отдельной coverage очереди |
| OLX полнота | `OLX_HTML_COVERAGE_INTERVAL_SECONDS` | `60` | Интервал HTML-сверки |
| OLX полнота | `OLX_PRIVATE_COVERAGE_INTERVAL_SECONDS` | `90` | Интервал private-сверки |
| Backfill | `BACKFILL_INTERVAL_SECONDS` | `300` | Интервал фоновой сверки |
| Backfill | `OLX_BACKFILL_MIN_INTERVAL_SECONDS` | `900` | Минимальный интервал фоновой OLX-сверки |
| Backfill | `BACKFILL_MAX_CANDIDATES` | `800` | Лимит кандидатов одной сверки |
| Защита | `RATE_LIMIT_PAUSE_BASE_SECONDS` | `90` | Начальная пауза rate limit |
| Защита | `RATE_LIMIT_PAUSE_MAX_SECONDS` | `3600` | Максимальная пауза rate limit |
| Защита | `CAPTCHA_PAUSE_SECONDS` | `900` | Начальная пауза CAPTCHA |
| Защита | `OLX_PROTECTION_COOLING_SECONDS` | `1800` | Период щадящего режима после защиты OLX |
| Telegram | `FAST_INLINE_TELEGRAM_SEND_ENABLED` | `true` | Первое сообщение на fast path |
| Telegram | `FAST_INLINE_LISTING_PROCESSING_ENABLED` | `true` | Inline-обработка найденных карточек |
| Telegram | `FAST_INLINE_LISTING_CONCURRENCY` | `4` | Параллельность fast path |
| Telegram | `FAST_INLINE_TELEGRAM_DEADLINE_MS` | `4000` | Жёсткий deadline inline-отправки |
| Telegram | `TELEGRAM_LISTING_SEND_MIN_INTERVAL_MS` | `1100` | Глобальный интервал начала отправки |
| Telegram | `TELEGRAM_FLASH_BUNDLE_ENABLED` | `true` | Ссылки burst сначала одним flash-сообщением |
| Telegram | `TELEGRAM_FLASH_BUNDLE_MIN_ITEMS` | `2` | Минимальный размер flash bundle |
| Telegram | `TELEGRAM_FLASH_BUNDLE_MAX_ITEMS` | `20` | Максимум ссылок в одном flash bundle |
| Telegram | `WORKER_CONCURRENCY_TELEGRAM_FLASH` | `1` | Параллельность durable flash-очереди |
| Хранение | `LISTING_RETENTION_HOURS` | `12` | Срок обычной карточки |
| Хранение | `LISTING_FAVORITE_RETENTION_DAYS` | `10` | Срок избранной карточки |
| Хранение | `LISTING_CLEANUP_INTERVAL_MS` | `300000` | Интервал очистки карточек |
<!-- runtime-config:end -->

## Источники

- `OLX` — главный realtime-источник.
- `AUTO_RIA` — официальный API при наличии ключа и доступной квоты.
- `RST` — HTML-источник; может включать CAPTCHA.
- `CARS_UA` — публичная выдача.
- `AUTOMOTO` — резервный агрегатор с точностью времени до дня.
- `MOCK` — только для тестов, по умолчанию выключен.

Статус каждого целевого источника доступен в `GET /health -> sourceHealth`. В `GET /system/check` блокировка основного OLX считается `FAIL`, а CAPTCHA или пауза вторичного источника — `WARN`, поэтому локальный проект не объявляется упавшим при работающем OLX. Целостность и задолженность 12-часовой/10-дневной политики хранения доступны в `GET /health -> listingRetention` и `GET /system/check`. В `GET /metrics -> latencyBySource` отдельно показаны задержки публикации, обнаружения и Telegram.

## Безопасность

- API и Dashboard слушают только loopback.
- Удалённый доступ разрешён только через приватный tailnet Tailscale.
- Браузер не получает `LOCAL_API_TOKEN`: его добавляет серверный BFF.
- Login rate limit хранится в Redis и ограничивает глобальный поток, клиент и пару клиент/учётная запись.
- Исходящие enrichment-запросы блокируют loopback, private, link-local и специальные IPv4/IPv6 диапазоны.
- `.env`, Android keystore, runtime и бэкапы закрыты ACL для текущего пользователя, `Administrators` и `SYSTEM`.
- Android/JDK/Gradle/Node загружаются из официальных источников и проверяются по закреплённым SHA-256.
- CI actions закреплены по commit SHA; Dependabot и CodeQL включены.

## Бэкапы

Ручной проверяемый бэкап:

```powershell
.\amb.cmd db:backup
```

Скрипт создаёт custom-format dump PostgreSQL, проверяет его через `pg_restore --list`, шифрует 7-Zip AES-256 с зашифрованными заголовками, выполняет `7z t` и сохраняет SHA-256/JSON metadata в `.runtime\backups`. Открытый dump удаляется. Пароль хранится только в локальном `.env` как `BACKUP_ENCRYPTION_PASSWORD`.

Полная проверка восстановления:

```powershell
.\amb.cmd db:restore:test
```

Для второй копии на другом физическом томе или UNC-пути задайте `BACKUP_MIRROR_PATH`. Скрипт намеренно отклоняет mirror на том же диске.

Создание ZIP с секретами запрещено. Обычный исходный архив без `.env`, `.runtime`, БД и ключей можно создать так:

```powershell
.\amb.cmd package:project
```

## Проверки

```powershell
.\amb.cmd check
.\amb.cmd audit:prod
.\amb.cmd android:check
.\amb.cmd db:verify:olx-reset
.\amb.cmd acceptance:extended
.\amb.cmd test:e2e
.\amb.cmd test:recovery
.\amb.cmd test:recovery:all
.\amb.cmd test:hot-failover   # только при monitoring.status=STOPPED
.\amb.cmd test:olx-parity
```

`acceptance:extended` поднимает на случайных loopback-портах полностью изолированные PostgreSQL и Redis 6+, запускает локальные OLX/Telegram HTTP-заглушки и физически проверяет отказы Redis, PostgreSQL и Telegram в критических точках pipeline. Рабочая `.env`, основная база, реальные OLX и Telegram не используются. Приёмка завершается только если каждое детерминированное объявление подтверждённо отправлено либо осталось в явном состоянии восстановления; в тот же прогон входит транзакционная проверка сброса 2000 OLX ID с реальной строкой Telegram-избранного.

Локальная 24-часовая оценка задержки Telegram хранит baseline в PostgreSQL и использует точный тракт `journalPersistedAt -> telegramAcceptedAt` из компактного `source_seen_listings`, поэтому 12-часовая очистка карточек не стирает телеметрию и старые приблизительные timestamps не могут дать ложный PASS/FAIL:

```powershell
# Один раз после изменения fast path:
.\amb.cmd metrics:telegram:baseline

# Предварительный отчёт сразу и итоговый отчёт после 24 часов:
.\amb.cmd metrics:telegram:24h
```

До истечения полных 24 часов отчёт имеет статус `COLLECTING` и не объявляет SLO пройденным или проваленным. После этого статус становится `READY`, а цель проверяется как `p95 <= 3000 мс`.

`test:e2e` при необходимости создаёт случайного временного dashboard-пользователя и гарантированно удаляет его после запуска. Для сценария реального stop/start дополнительно задаётся `E2E_ALLOW_USER_DB=true` только в тестовом процессе.

`check` и обычный `build` собирают TypeScript и Next.js в изолированные временные каталоги, не меняя запущенные `dist`/`.next`. Рабочие артефакты обновляет только `build:deploy` во время контролируемого старта. Локальный E2E использует отдельный dashboard на `127.0.0.1:3101` и `.next-e2e`, поэтому не останавливает production-сайт на порту 3001.

`check` также запускает V8 coverage для API/worker/shared и применяет минимальные пороги statements/lines 24%, branches 70%, functions 38%. Порог намеренно фиксирует текущий доказанный baseline и не позволяет покрытию тихо ухудшаться.

Диагностика:

```powershell
.\amb.cmd doctor
.\amb.cmd local:status
```

API поддерживает ограниченные `limit`, cursor pagination и возвращает `400` для некорректных query-параметров:

```text
GET /listings?limit=50&cursor=...
GET /listings/recent?limit=50&cursor=...
GET /logs?limit=100&cursor=...
```

## Android и Tailscale

```powershell
.\amb.cmd android:build
.\amb.cmd remote:setup
```

Панель остаётся недоступной из публичного интернета. Текущий режим — приватный TCP внутри зашифрованного Tailscale-туннеля. Приложение принимает только loopback/LAN/Tailscale-адреса; публичный HTTP URL отклоняется. Проверка HTTPS выполнена, но этот Tailscale-аккаунт не поддерживает выдачу TLS-сертификатов, поэтому Android cleartext нельзя отключить без изменения внешней настройки аккаунта.

## Ограничения, которые нельзя устранить только кодом

- Сайты могут менять HTML/API, вводить CAPTCHA или rate limit.
- На выключенном ноутбуке локальный проект не работает.
- Для app-layer HTTPS нужен Tailscale-аккаунт с поддержкой TLS certificates; текущий приватный TCP уже защищён самим WireGuard-туннелем.
- Абсолютную полноту чужой площадки без официального event stream доказать невозможно; `test:olx-parity` количественно сравнивает доступные public/API/HTML/private выдачи с памятью проекта.

Актуальная проверенная оценка и оставшиеся риски находятся в [AUDIT.md](./AUDIT.md).
