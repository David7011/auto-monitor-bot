# Этап 2 — OLX recovery

Цель: сократить бесполезные повторные запросы, сохранить найденные объявления и честное доказательство полноты. Основной commit `7334eb92932907bf3e4acbaac75c892b279680c6`; исправление surviving lease `6659a996a646da6c3f66ca59476bb0af23aba30c`; финальный commit `a4a24a50bd06e55a96ce77227726d1e2ee5c3a9d` устраняет голодание фонового слота. Release `a4a24a50bd06-20261012210057` выпущен и проверен после полуночи 13 октября по Киеву (12 октября UTC).

## Что исправлено

1. **Доказательство всей overlap-страницы.** Evidence v2 сохраняет полный набор ID с учётом повторов, scope/page и канал выдачи. Перестановка внутри уже обработанной страницы допустима: её состав не изменился и весь состав уже прошёл обработку. Добавление/удаление ID, перенос между страницами, смена канала, пропавшая лента, неоднозначный дубликат target и неидентифицируемые карточки не дают ложного proof.
2. **Кандидаты с изменившегося overlap.** Ранее collector выходил до их обработки. Теперь объявление, сдвинувшееся назад после удаления выше по выдаче, тоже попадает в результат и durable journal. Если бюджет кандидатов исчерпан, курсор сохраняется, следующая попытка дочитывает остаток; терминальный UNRESOLVED не блокирует необработанные карточки.
3. **Временный сбой ≠ предел источника.** Неполная дополнительная лента оставляет попытку повторяемой с NO_PROGRESS. Сам по себе timeout не устанавливает постоянный UNSTABLE_PAGINATION. Настоящее изменение состава страницы остаётся недоказанным.
4. **Общий проход для pending windows одного shard.** Writer выбирает старейший required cutoff, сохраняет все строки и их исходные причины, обновляет общий progress и закрывает все pending требования одним CUTOFF proof. Недавний KNOWN_TAIL не закрывает несколько исторических диапазонов. Разные shards изолированы.
5. **Capability retry по группам.** Версия алгоритма v2 даёт одну новую возможность проверки. API блокирует строку state и делает один bulk transition на shard вместо отдельного reset/transaction на каждый старый window. Используется минимальный cutoff, anchors сбрасываются: повторное доказательство исторических окон требует timestamp coverage. Обычный restart не меняет generation. Старая legacy evidence перестраивается один раз. Неактивные planner scopes сохраняют историю; eligibility требует успешный realtime scan за последние 15 минут, поэтому возвращённый scope становится eligible после своего следующего realtime scan.
6. **Пауза после NO_PROGRESS.** Для ошибок загрузки backoff 5/10/20/40/80/160/300 секунд; после доказанного продвижения — 1 секунда. Занятый realtime-слот проверяется снова через 5 секунд без HTTP-запроса: экспоненциальная пауза здесь приводила к повторному попаданию в занятую фазу realtime и голоданию recovery. Счётчик deferrals сохраняется для диагностики. Realtime overflow сохраняет deadline. Worker проверяет его перед source request даже для уже стоящей в очереди задачи. Старый обычный BACKFILL job при pending recovery использует тот же durable cursor. Это ограничение фоновой исторической работы; realtime продолжает собственное расписание.
7. **Поздний replay.** Более старый attempted cursor не перезаписывает overlap более нового cursor. KNOWN_TAIL от старого snapshot не закрывает окно после изменения frozen anchors.
8. **Точная граница бюджета.** Полностью классифицированная cutoff-страница завершает проход даже при ровно заполненном бюджете; дополнительная страница для этого не запрашивается.
9. **Recovery после surviving lease.** LIVE-проверка выявила сохранённую после остановки worker lease и завершённую без нового scan задачу. Один retry через прежние ~800 ms тоже сталкивался с lease; затем completed jobId блокировал следующий сигнал. Новый jobId включает capability hash, поэтому re-arm новой версии не совпадает с прежней задачей. При столкновении OLX RECOVERY ждёт оставшийся TTL существующей lease + 250 ms; retry остаётся один, чужая lease не удаляется. Realtime по-прежнему coalesces без очереди поздних source requests.

OLX origin остаётся сериализованным. Частота Telegram и действующие настройки challenge/Chromium сохранены. Миграции production schema и ручные изменения production data для выпуска не нужны.

## Проверки

- Финальная unit/regression suite: **137 files / 862 tests**, без stderr в vitest. Включены lock-retry, capability jobId и освобождение realtime-слота после повторных deferrals. Полный release gate прошёл: types, lint, coverage, schema/docs, PowerShell, backup/CI policy и isolated production build.
- Fixtures: head insertion/deletion, promoted relocation, harmless permutation, duplicate multiplicity, channel switch, missing/private feeds, unidentifiable ID, empty/offset ceiling, частичный ingest, повтор после crash, deadline/no slot, stale snapshot, cutoff и candidate budget.
- Recovery-only acceptance с отдельными PostgreSQL/Redis: настоящий row lock, concurrent writers, сохранение counters/cutoff/cursor после reconnect, несколько окон с одним proof, защита от недавнего anchor и stale overlap, category/parser isolation, legacy shard re-key, сохранение original reasons. `scripts/test-pipeline-resilience.ps1 -RecoveryOnly` прошёл.
- Полный fault-injection стенд Telegram не заявляется пройденным: в существующем harness были устаревшие Telegram assertions, в частности ожидание только SENT/UPDATED при реальном DELIVERED. При первом запуске исправлен старый lookup single listingId на существующий compound key listingId_chatId; следующие Telegram assertions не менялись в этом этапе. Новые SQL recovery-сценарии прошли отдельным режимом.

Acceptance evidence: `.runtime/audit/pipeline-20261012233503-d5f45c/` и scratch log `olx-recovery-isolated-20261012.log`.

## Baseline и предел результата

Перед выпуском, `2026-10-12T20:35:33.520Z`: 554 UNRESOLVED/UNSTABLE_PAGINATION v1 и 234 VERIFIED; pending в момент снимка отсутствовали. Активный shard имел свежий realtime scan, retired shard — последний success 11 октября. Baseline сохранён в `.runtime/audit/olx-recovery-before-20261012.json`.

В fixture безвредная перестановка overlap теперь заканчивается VERIFIED за три feed requests суммарно (page 1; затем page 2 + повтор page 1), вместо остановки UNRESOLVED с необходимостью нового прохода. В тесте 400 старых окон + 1 pending выполняется одна transaction/reset на shard, а не 401. Эти результаты относятся к проверенным сценариям; процент ускорения production по короткому снимку не обещается.

Источник использует изменяемые offset pages. Ни успешный HTTP, ни пустая страница, ни новая версия алгоритма не доказывают отсутствие всех пропусков в недостижимом историческом диапазоне. Такие требования остаются UNRESOLVED; их строки не удаляются и не превращаются в VERIFIED без evidence. Новое действительно расширенное свежее gap может требовать отдельного прохода: подавлять его только потому, что старый диапазон unreachable, означало бы ухудшить текущую полноту.

## LIVE после выпуска

Финальный LIVE возобновлён `2026-10-12T21:01:22.996Z`. Проверка `21:02:34.409Z` подтверждает accepted revision `a4a24a50bd06`, API OK, RUNNING, 2 active sources, свежие success обоих источников, consecutiveErrors=0, отсутствие FAILED/RATE_LIMITED/CAPTCHA_DETECTED. OLX: два завершённых realtime scan 8,569/8,933 с, интервал 22 с при настройке 20±4 с. AUTO.RIA: два scan 1,019/0,709 с, интервал 63,2 с при настройке 60±5 с. Retention OK, due/overdue/invalid/unmanaged=0. AUTO.RIA LIMITED сохраняет прежнюю novelty caveat.

На предыдущем выпуске этого этапа LIVE подтвердил cursor 1→2 и последующий запрос page 2 + overlap page 1. Реальное изменение состава overlap сохранило исторические требования как UNRESOLVED. Перед финальным restart также появились два VERIFIED окна generation v2. Финальный снимок: активный shard — 468 UNRESOLVED v2 и 235 VERIFIED (из них два v2), retired shard — прежние 90 UNRESOLVED v1 и два VERIFIED. Pending отсутствуют; финальный restart не запустил заново завершённые исторические попытки. Новая ветка 5-секундного slot deferral проверена regression с реальным arbiter; в коротком финальном LIVE-окне новых BACKFILL попыток не было, поэтому её production cadence пока не измерен.

Evidence: `.runtime/audit/olx-recovery-live-before-slot-fix-20261012.json`, `.runtime/audit/olx-recovery-live-after-20261012.json`; release gate log `olx-recovery-slot-check-20261012.log` в scratch. Это короткая проверка запуска и поведения recovery, а не доказательство длительной устойчивости, полноты всей недоступной истории или end-to-end доставки нового объявления на телефон.

Следующий этап: измерить и сократить parsed→candidate/handoff delay, сохранив durable admission и независимость фонового enrichment.

Дополнительное LIVE evidence во время выпуска этапа 3, 13 октября по Киеву: в `21:09:34.819Z` recovery получил BACKGROUND_SLOT_UNAVAILABLE без HTTP-запроса, следующий scan начался `21:09:39.920Z` и завершился `21:09:41.964Z`, requestCount=1, 52 observations, VERIFIED/CUTOFF. Это подтверждает 5-секундный retry и успешное освобождение слота на production. Снимок `.runtime/audit/handoff-live-after-20261013.json`.
