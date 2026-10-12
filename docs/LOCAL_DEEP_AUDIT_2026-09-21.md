# Auto Monitor Bot — локальный аудит 21 сентября 2026

Проверен локальный `main`, commit `1fa4e5e63c8c4b244616c78a37bbc5e59849ea33`, совпадающий с локальным `origin/main`. Исследованы исходники, действующая БД, production health, журналы supervisor, hot-path telemetry, проверки completeness и retention. Окончательная сверка: **2026-09-21T14:27:27Z**, 17:27 по Киеву. Рекомендации сверены с первичными техническими источниками.

Production в ходе аудита не перезапускался автором аудита; cadence, transport, исходники приложения и данные не исправлялись. Временные диагностические скрипты и тесты удалены после проверки. Преднамеренные отключения ноутбука и снятая пользователем флешка не считаются дефектами приложения.

**Оценка: примерно 6.5/10 по совокупности поставленных целей.** Это инженерная оценка, а не измеренная вероятность отказа. Архитектурная основа сильная, но гарантии автономности и полноты пока слабее, чем предполагают некоторые статусы и документация.

| Направление | Оценка | Основание |
|---|---:|---|
| Архитектура обработки | 7.5/10 | Durable journal, transactional outbox, отдельные очереди, fencing/leases; есть проблемы на границах компонентов |
| Самовосстановление | 6/10 | Умеет восстанавливать умершие процессы; зависший API и validation lock оставляют пробелы |
| Скорость после HTTP-запроса | Предварительно 7/10 | Несколько секунд на наблюдаемом пакете; нынешняя выборка слишком мала для устойчивых хвостов |
| Скорость обнаружения | 5.5/10 | Реальный STANDARD 120±20s существенно ограничивает скорость независимо от быстроты Node.js |
| Доказанность отсутствия пропусков | 5/10 | Два воспроизведённых контрпримера recovery; 410 continuity-only ID без replayable payload |

**Что действительно работает сейчас**

- API, PostgreSQL, Redis, dashboard, два hot-worker и background-worker доступны. Leader/standby согласованы, supervisor heartbeat свежий.
- OLX `ACTIVE`, consecutiveErrors=0, последняя успешная realtime-проверка при окончательной сверке: `14:26:28.516Z`.
- Очереди первого обнаружения/отправки не имели backlog или failed. На промежуточном снимке enrichment имел 3 active и 7 prioritized jobs — это фоновая работа, не доказательство зависания доставки.
- AUTO.RIA и AutoMoto получают данные, но имеют `LIMITED` из-за ограничений доказуемости времени/порядка/полноты публичных выдач. RST остаётся `DISABLED`.
- Retention утром имел 105 overdue, затем штатно обработал batches по 50; на финальном снимке due/overdue=0. Исчерпанных delivery-попыток в текущих notification rows нет.
- БД около 78 MB, `fsync=on`, `synchronous_commit=on`; у API pool waiting=0, запрос health к PostgreSQL около 1 ms. Доказательств текущего CPU или DB saturation не получено.

**1. P1 — recovery может пропустить существующее объявление и всё же вернуть VERIFIED**

Успешно воспроизведено с настоящим `OlxCollector` и подменённым HTTP feed, без обращений к OLX и production БД:

1. Исходная выдача содержит ID 1…151, размер страницы 50. Замороженные anchors — 141…151.
2. Первый и второй короткие проходы получают 1…50 и 51…100.
3. На источнике удаляется ID 1. ID 101 сдвигается с начала третьей страницы в конец второй.
4. Recovery продолжает с page 3 и получает 102…151.
5. Возвращаются `progress=4`, `coverageVerified=true`, хотя ID 101 остаётся на источнике и не был обработан.

Вывод диагностического теста:

```json
{"requests":[1,2,3],"progress":4,"verified":true,"missingId":"101","stillUpstream":true,"recovered101":false}
```

Причина: [olx.ts:745](C:/Projects/auto-monitor-bot/apps/worker/src/collectors/olx.ts:745) продвигает номер страницы по факту наблюдения. Overlap на строках 753–754 сохраняется, но не используется для проверки стыка страниц. Поздний known tail/cutoff не доказывает отсутствие дырки между ранее прочитанными страницами. [Текущий тест:27](C:/Projects/auto-monitor-bot/tests/olx-realtime-recovery-isolation.test.ts:27) проверяет неподвижную выдачу.

Исправление: durable progress оставить монотонным, но отдельно вести доказательство непрерывности просмотренного участка: границы ID/времени страницы, результаты проверки overlap, состояние непроверенного стыка. Повторную проверку стыка проводить в разрешённом background slot; при необъяснимом сдвиге сохранять UNRESOLVED и bounded reconciliation. VERIFIED требует непрерывной цепочки evidence и terminal boundary. Простое перечитывание одной страницы тоже не гарантирует полноту при произвольном изменении выдачи — контракт должен честно описывать допущения.

Приёмка: вставки, удаления, promoted/reordered элементы между каждой парой проходов; один slot за cycle; crash до/после journal и cursor commit. Ни один остающийся в модельной выдаче ID не теряется; неоднозначная непрерывность не получает VERIFIED.

Ранее этап 3 был назван полностью закрытым. Новые контрпримеры показывают: устранён повтор статичной страницы, но формулировка «исключён ложный VERIFIED» была сильнее имевшихся доказательств. Конкретные потери в реальном OLX этим тестом не установлены.

**2. P1 — candidate limit не останавливает продвижение durable cursor**

Второй тест: 50 корректных неизвестных объявлений, `maxCandidates=10`. Результат — 10 кандидатов, observedCount=50 и nextPage=2. Оставшиеся 40 payload не переданы для journal; recovery уже пропускает страницу.

```json
{"candidates":10,"observed":50,"nextPage":2}
```

[olx.ts:1170](C:/Projects/auto-monitor-bot/apps/worker/src/collectors/olx.ts:1170) отмечает candidateLimitReached, но проверка продвижения на строках 745–754 это не учитывает. Сейчас production BACKFILL_MAX_CANDIDATES=800, поэтому тест не доказывает текущую потерю на каждой странице; ошибка действует при достижении оставшегося бюджета, и малое значение допускается конфигурацией.

Лучшее решение: отдельно ограничить нормализацию/доставку и durable ingest страницы. Cursor коммитить после сохранения всего необходимого page payload либо хранить внутристранничный continuation. При неполном ingest фиксировать NO_PROGRESS/CANDIDATE_BUDGET, не перепрыгивая остаток. Приёмка — лимиты 1/10/49/50/51, несколько feeds, crash в середине сохранения.

**3. P1 — supervisor не гарантирует восстановление зависшего API**

[supervisor.ps1:287](C:/Projects/auto-monitor-bot/scripts/supervisor.ps1:287) подавляет recovery при живых PID/worker heartbeat и открытых портах PostgreSQL/Redis, несмотря на повторяющийся провал `/ready`. Watchdog делегирует сбой активному supervisor. API может оставаться живым процессом с зависшим event loop; его scheduler перестанет выдавать работу.

Нужны отдельные liveness API/dashboard и deadline продвижения scheduler, с ограниченным targeted restart только зависшего компонента. Dependency readiness и работоспособность процесса имеют разный смысл; это соответствует [официальной модели probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/). Для применения этого принципа Kubernetes не нужен.

Приёмка: изолированный API с зависшим event loop и живым PID восстанавливается в установленный SLO, здоровые worker/DB сохраняются. Нынешние kill-process acceptance не покрывают hang.

**4. P1 — validation lock выключает самовосстановление на время release gate**

[check.ps1:25](C:/Projects/auto-monitor-bot/scripts/check.ps1:25) держит validation.lock через весь gate. [supervisor.ps1:245](C:/Projects/auto-monitor-bot/scripts/supervisor.ps1:245) пропускает проверки при этом lock; [watchdog.ps1:327](C:/Projects/auto-monitor-bot/scripts/watchdog.ps1:327) также прекращает действия восстановления. Длительный или зависший тест оставляет production без self-heal.

Разделить validation mutex и короткую deployment maintenance lease с expiry. Validation не должна блокировать liveness и targeted recovery. Приёмка: долгий validation-run одновременно с падением изолированного worker, восстановление в прежнем SLO. Полный release gate в этом аудите повторно не запускался; применены адресные тесты.

**5. P1 — автоматическое восстановление может развернуть незавершённые исходники**

[start.ps1:507](C:/Projects/auto-monitor-bot/scripts/start.ps1:507) останавливает приложения, затем запускает migrate deploy и при устаревших артефактах build из текущего рабочего каталога. Full supervisor recovery использует этот же путь. Изменения на диске могут стать production до release gate; ошибка сборки оставит приложения остановленными.

Лучший архитектурный шаг: отдельный каталог принятого release с commit, hashes и manifest. Supervisor запускает только принятые артефакты. Build, backup и миграции выполняет явная процедура deploy; переключение release и rollback контролируются отдельно. Это улучшение развёртывания без переписывания collectors/DB/Telegram.

Приёмка: грязный checkout и намеренно некомпилируемый новый код не мешают восстановить старый принятый release. Совместимость rollback с additive/non-additive миграциями проверяется отдельно.

**6. P1 — после длительного transient-сбоя доставка может перестать повторяться**

[delivery-outbox.ts:34](C:/Projects/auto-monitor-bot/apps/worker/src/modules/delivery-outbox.ts:34) отбирает только attemptCount<10; flash recovery имеет аналогичный предел. [telegram-service.ts:733](C:/Projects/auto-monitor-bot/apps/worker/src/modules/telegram-service.ts:733) расходует попытку ещё до admission/HTTP. После исчерпания существующих queue jobs строка может остаться в БД, но больше не выбираться для восстановления.

Нужны durable nextAttemptAt, transient/permanent/ambiguous classification, capped backoff с jitter. Transient нельзя навсегда прекращать из-за lifetime-счётчика; terminal/quarantine должно быть явным, видимым и иметь понятную причину. [BullMQ рекомендует идемпотентные jobs](https://docs.bullmq.io/patterns/idempotent-jobs) и [явный backoff](https://docs.bullmq.io/guide/retrying-failing-jobs).

Приёмка: outage длиннее десяти попыток, возврат зависимости, доставка автоматически завершается. Текущих исчерпанных уведомлений в финальном снимке нет — это подтверждённый путь отказа, не объявление нынешней потери.

**7. P1 — Telegram exactly-once имеет незакрытое ambiguous window**

[telegram-service.ts:202](C:/Projects/auto-monitor-bot/apps/worker/src/modules/telegram-service.ts:202) отправляет sendMessage, затем на строке 218 сохраняет receipt. Потеря ответа или crash до записи messageId допускает повтор при восстановлении. Защита lease/CAS закрывает конкуренцию, но не эту неоднозначность. [Bot API sendMessage](https://core.telegram.org/bots/api#sendmessage) возвращает Message при успехе и не документирует client idempotency key.

Нужны отдельное AMBIGUOUS, повтор сохранения уже полученного receipt без повторного HTTP и явная политика для потерянного ответа. Локальный durable receipt spool уменьшит окно при временном сбое PostgreSQL. Он не создаст абсолютную распределённую exactly-once гарантию. Для цели «не пропускать» обычно предпочтительна контролируемая at-least-once доставка с редкими видимыми дублями в неоднозначном случае; этот компромисс следует документировать.

**8. P1/P2 — priority Telegram ограничен процессом**

[telegram-send-gate.ts:47](C:/Projects/auto-monitor-bot/packages/shared/src/utils/telegram-send-gate.ts:47) сортирует приоритет локально. Redis Lua spacing получает только interval, а не priority. Background cleanup/edit и новое OLX уведомление из другого процесса конкурируют за общий slot по времени прихода. Приоритет OLX до HTTP источника не означает приоритет на последнем участке доставки.

Вариант улучшения: единый admission owner либо Redis очередь ожидающих с priority, TTL/lease и защитой от starvation. Сохранить общий rate limit/retry_after. Приёмка — multiprocess contention: OLX получает следующий ещё не занятый slot перед накопленными background edits; downstream ограничения соблюдаются.

**9. P1 наблюдаемости — нынешняя telemetry недостаточна для выбора оптимизации**

Новый baseline после запуска: `2026-09-21T14:24:14.576Z`. В `14:26:14Z` получено 8 полных accepted listing traces, но это **один requestStartedAt и один telegramAcceptedAt**. Утренние 6 traces также были только двумя запросами. Трассы объявлений валидны для listing-weighted измерения, но коррелированы; 100 объявлений не равны 100 независимым HTTP/Telegram событиям. Для canary нужны одновременно достаточное число объявлений, независимых runs/requests и длительность стабильного окна.

Наблюдаемые значения p50 внутри этого одного нового пакета, не устойчивый production benchmark:

| Участок | Значение |
|---|---:|
| request start → headers | 2267 ms |
| headers → body | 716 ms |
| body → parsed | 198 ms |
| parsed → candidate | 23 ms |
| candidate → durable journal | 17 ms |
| durable journal → filter | 170 ms |
| filter → Telegram request | 726 ms |
| Telegram request → acceptance | 105 ms |
| request start → acceptance | 4282 ms |

Медианы участков не следует складывать как медиану полного пути. p95/p99 для текущего baseline не публикуются. Исторические 300+ traces относятся к разным runtime/режимам и не являются текущим homogeneous baseline.

Детальные network samples=0: [windows-source-http.ts:5](C:/Projects/auto-monitor-bot/apps/worker/src/lib/windows-source-http.ts:5) отдаёт только headers/body timestamps, тогда как network collector слушает Undici. Windows OLX HTTP идёт через отдельный persistent helper. Body→parsed включает Base64/JSON IPC, декодирование и обработку, поэтому это не чистое CPU parse time.

Добавить native transport timing, IPC/decode/parse spans, bytes и явные unavailable поля. Измерить отдельно origin admission, DB reserve, TelegramGateWait. Первую trace закрепить immutable: normalizedData сейчас обновляется последующими observations, а первые timestamps остаются прежними.

После утреннего fast recovery commit в experiment был `unknown`; после последнего full start он корректен (`1fa4e5e…`). recover.ps1 не устанавливает AMB_CODE_REVISION так, как это делает start.ps1. Release manifest должен быть единым источником identity для всех путей запуска. [Canary-практика Google SRE](https://sre.google/workbook/canarying-releases/) подчёркивает сравнимость эксперимента и критерии оценки.

**10. P1/P2 — effective cadence пока не используется всеми потребителями**

Production STANDARD=120±20s, LIVE config=20±4s. Canary фактически DISABLED: его effective config enabled=false при STANDARD baseline, несмотря на enabled=true в .env. В рамках предыдущих этапов cadence сознательно не переключали; текущий медленный режим не следует маскировать советом оптимизировать parse.

[system-health-routes.ts:385](C:/Projects/auto-monitor-bot/apps/api/src/routes/system-health-routes.ts:385) использует LIVE interval независимо от режима. В `14:26:22Z` health показал OLX FAIL на возрасте 123s при допустимом STANDARD interval до 140s. Через 6s realtime завершился успешно (`14:26:28.516Z`). Это отдельный подтверждённый false health сигнал, несмотря на уже исправленный outage detector.

Все health/canary/watchdog/UI потребители должны использовать согласованные effective deadline и scheduler tolerance. После исправлений полноты/health и накопления валидной выборки — контролируемый возврат LIVE20±4 через существующий механизм. Canary18±3 допустим только при exact20±4 baseline и выполнении остальных guards.

При равномерном времени появления относительно опросов модель даёт около 60s среднего ожидания при 120s и около 10s при 20s. Потенциал примерно 50s — оценка polling-модели, не измеренный BEFORE/AFTER и не гарантия видимости объявления на OLX.

**11. P2 — background pressure нужно оценивать по добавочной пользе**

В финальном 24h срезе: OLX realtime —143 HTTP-запроса успешных runs; coverage —284 запроса, почти вдвое больше, newCount=0. Backfill —24 запроса. Это не доказательство бесполезности coverage: он может давать continuity evidence, а attribution newCount неполна. Но именно здесь стоит измерять unique discoveries, unique journal payload, boundary evidence и предотвращённые overflow на каждый запрос.

Улучшение: coverage budget по фактической пользе и давности evidence, общий request plan/cache для одинаковых поисков и коалесцирование запросов. Не отключать coverage по одному newCount=0. Для похожих поисков объединение допустимо только при доказанном superset и достаточной глубине; иначе экономия запросов создаст пропуски. Realtime admission должен оставаться первым, background — с bounded budget и backoff.

**12. P1/P2 — backup orchestration не переживает временную недоступность mirror правильно**

Снятая флешка — решение пользователя. Программная ошибка независима от этого: [backup-database.ps1:73](C:/Projects/auto-monitor-bot/scripts/backup-database.ps1:73) выходит по свежему локальному backup до попытки дослать mirror. Если mirror failure возник после создания локальной копии, scheduled retry может вернуть success, не выполнив mirror. Exception mirror также перескакивает локальную retention на строке 149.

Разделить local backup, доставку mirror и retention на самостоятельные устойчивые стадии; durable retry уже созданного зашифрованного архива, проверка SHA и atomic publish. Отдельные статусы/alerts для backup freshness и restore drill, без рестарта мониторинга. Постоянно доступное независимое хранилище лучше подходит автономной работе, чем обязательное ручное подключение носителя.

Текущий local backup: `database-20260921-000223.ambbak`, возраст 17.4h при проверке; независимый mirror недоступен, подтверждение последнего independent restore отсутствует. Ежедневный dump оставляет RPO порядка суток даже при успешном mirror. Для этой небольшой БД сначала оценить более частые encrypted logical backups; строгий низкий RPO требует отдельной оценки [PostgreSQL continuous archiving/PITR](https://www.postgresql.org/docs/18/continuous-archiving.html). Это не предложение переносить живой pgdata.

**Дополнительные улучшения второго приоритета**

- `GET /monitoring/status` вызывает ensureState/ensureSources с upsert. Чтение статуса пишет БД и обновляет newestFirstVerifiedAt из статического definition. Bootstrap reconciliation следует вынести из GET, а реальные capability evidence датировать отдельно от config. Источники: [control.ts:97](C:/Projects/auto-monitor-bot/apps/api/src/modules/monitoring/control.ts:97), [orchestrator.ts:92](C:/Projects/auto-monitor-bot/apps/api/src/modules/monitoring/orchestrator.ts:92).
- `completeness:check` в 14:26:55Z: ok=true, fullyRecoverable=false, impossibleCount=0, continuityOnly=410, replayable=0. Утренний показатель был 275. Эти IDs не являются автоматически потерянными пользовательскими уведомлениями: часть может быть legacy, cutoff или continuity anchors. Нужны provenance и раздельный подсчёт полученных payload, намеренно пропущенных старых ID и действительно незавершённого ingest. Checker не знает объявления, которые ни разу не попали в систему.
- Retention уже имеет fair ordering/backoff и сам очистил backlog. Улучшить drain ETA и разбор причин; при накоплении — несколько ограниченных batches с уступкой hot Telegram. Legacy adoption имеет отдельный дефект: permanent markup failure выбирается снова без backoff ([listing-retention.ts:159](C:/Projects/auto-monitor-bot/apps/worker/src/modules/listing-retention.ts:159)); к текущему backlog это не относилось, unmanagedFresh=0.
- Не складывать lifetime occurrences ошибки в показатель «ошибки за 24h». Например editMessageText=1711 — накопленный счётчик с июля, а не 1711 событий сегодня. Нужны временные buckets ошибок и отдельные transient/protection/programming classes.
- HealthScore100 или процесс RUNNING не доказывают успешную бизнес-цепочку. Добавить age oldest pending observation/outbox, scheduler deadline lag, unresolved continuity age, delivery success ratio и независимую проверку доступности HP. Это соответствует подходу [Google SRE к monitoring](https://sre.google/sre-book/monitoring-distributed-systems/). Наблюдатель вне HP может уведомить о пропаже машины, не становясь вторым producer.

**Что сохранять в архитектуре**

Durable journal перед Redis и отправкой; nested transaction listing+matches+delivery intent; PostgreSQL unique identity; renewable Telegram leases/CAS; independent hot/background queues; realtime origin preemption; bounded retries; безопасную классификацию 403/429/CAPTCHA; фактическую поддержку keep-alive уже существующим Windows helper; replay незавершённой durable работы; retention tombstones; изолированные acceptance tests.

Possible duplicate/enrichment уже выведены из первого уведомления. Их перенос «ещё раз» не даст выигрыша. Go/C#/worker_threads и замена всей архитектуры сейчас не обоснованы. Сначала устранить scheduling/proof/delivery дефекты и измерить Windows transport + Telegram gate. SQL candidate improvements — atomic reservation UPDATE RETURNING и объединение observation-dispatched с listing/outbox transaction — проверять только после span measurements; durability/uniqueness не убирать ради миллисекунд.

**Рекомендуемая последовательность**

| Этап | Изменение | Критерий завершения |
|---|---|---|
| 1 | Recovery continuity + candidate budget | Оба контрпримера закрыты; mutation/crash tests не теряют ID и не дают ложный VERIFIED |
| 2 | API hang recovery + validation lock | Изолированные hang/kill во время gate восстанавливаются автоматически в SLO |
| 3 | Принятый immutable release | Recovery не собирает и не мигрирует изменяемый checkout; проверен rollback |
| 4 | Delivery transient/ambiguous states | Длительный outage не оставляет вечных pending; ambiguous явно видны |
| 5 | Effective health + transport/request trace | Нет ложного STANDARD FAIL, отдельные request counts/spans, правильный release identity |
| 6 | Telegram admission priority | Multiprocess OLX выигрывает следующий свободный slot при background нагрузке |
| 7 | Request budget и LIVE | Без потерь/evidence regression; затем 20±4, после достаточной выборки guarded18±3 |
| 8 | Backup mirror retry и RPO | Offline→online mirror retry работает без нового dump, restore с независимой копии PASS |

Порядок отражает цель: сначала устранить потерю/ложную уверенность, затем гарантировать восстановление, после — ускорять. Размер файлов, глобальный coverage процент и смена языка не являются самостоятельными целями.

**Проверки этого аудита**

- Повторно выполнены 71 адресный тест в 12 файлах: recovery, outage, arbiter, delivery-outbox, Telegram acceptance/gate, retention, health, qualification и completeness — PASS.
- Два временных диагностических теста подтвердили именно уязвимое поведение recovery. Их PASS означает воспроизведение дефекта, а не исправность контракта. Оба удалены после фиксации результатов в отчёте.
- Выполнены read-only CLI metrics/completeness, retention dry-run, прямые read-only SQL snapshots с RepeatableRead, production local:status.
- Существующие 681 тест и полный release gate были выполнены на этом commit предыдущим этапом; повторно все 681 в этом аудите не запускались. Успех текущих тестов не покрывает найденные новые сценарии.

Абсолютное «все объявления OLX без единого пропуска при любой ситуации» не доказуемо по изменяемой публичной выдаче: есть краткоживущие/неиндексированные записи, изменения порядка и недоступность источника. Практический сильный контракт: каждый полученный payload надёжно сохраняется, незавершённая работа восстанавливается, локальные дыры не скрываются, а внешняя неопределённость остаётся явно UNRESOLVED. Именно это следует довести до проверяемого состояния.
