# Multi-category upgrade — контрольный отчёт A–R

Дата: 07.09.2026. Статус: отдельный этап исправлений, **не завершение полного ТЗ**.

## A. Исходное состояние

До архитектурного апгрейда: автомобильный OLX-first монитор, durable PostgreSQL observation journal, BullMQ, разделённые realtime/backfill/coverage, active/standby hot workers, общий OLX coordinator и Redis Telegram gate. Laptop-first модель сохранена: выключенный ноутбук и намеренный STOPPED не считаются аварией.

До текущего продолжения уже были добавлены registry восьми категорий, additive schema, category-aware planner/normalization/filter/Telegram/UI. На ноутбуке оставался один боевой автомобильный фильтр. Предыдущая общая проверка была зелёной, но часть гарантий нового режима не проверялась end-to-end.

## B. Что найдено при продолжении

1. Shadow подавлял первую отправку только в памяти. Сохранённый листинг мог попасть в Telegram при повторной обработке; журнал не всегда связывался с его ID.
2. UI электроники показывал бюджет UAH, evaluator сравнивал USD-normalized цену.
3. Non-car normalization запускала автомобильные inference/price функции.
4. Первая встреченная RAM/ёмкость считалась истиной даже при противоречивых значениях.
5. GPU criteria читали `gpu`, хотя GPU profile сохранял `model`.
6. Cleanup search states мог каскадно удалить историю непокрытых offline windows.
7. Копирование части полей predecessor теряло курсоры/cutoff и FK истории recovery; проверка AUTO.RIA scope не учитывала марку.
8. Coverage-write доверял вызывающему коду и мог принять чужой context или противоречивые parser/verified флаги.
9. Mixed-category duration ошибочно преобразовывалась в vehicle.car.
10. Non-car listings бесконечно попадали в vehicle-enrichment recovery из-за отсутствия VIN/market результата.

## C. Принятые решения

- Durable `Listing.notificationMode` LIVE/SHADOW с ограничением БД. Provisional reasons хранятся вместе с карточкой.
- Повторная отправка и flash проверяют запрет. Старый mixed flash с suppressed entries направляет только допустимые записи в отдельные карточки; не отправляет сохранённый опасный текст.
- Продвижение SHADOW → LIVE выполняется после свежего положительного live-filter evaluation; matches обновляются транзакционно. Автомобильным дублям не добавлен отдельный сетевой/DB каскад продвижения.
- Для non-car используется original UAH; неизвестная валюта не превращается в ложный match/reject. Vehicle USD поведение сохранено.
- Эквивалентный planner transition меняет fingerprint той же строки: известный хвост, курсор, cutoff и recovery windows остаются на месте. Разные категории/географии/AUTO.RIA марки не наследуют состояние друг друга.
- Recovery history исключена из автоматического удаления. Parser health и ownership проверяются непосредственно перед записью.

## D. Отклонённые альтернативы

- Удаление shadow-листингов: потеряло бы наблюдения и возможность повторной оценки.
- Запрет только в collector: не защищает replay/queued Telegram jobs.
- Неявная UAH/USD конверсия без доказанного курса: давала бы неверные совпадения.
- Копирование нескольких anchor-полей в новую строку: не сохраняет всю историю recovery.
- Сброс CAPTCHA/403 ради live-теста и умножение OLX concurrency: не применялись.
- Объявить все восемь profiles готовыми по одним unit-тестам: недостаточно доказательств.

## E. Изменённые компоненты текущего этапа

- Domain/DB: `packages/shared/src/types/category.ts`, `packages/db/prisma/schema.prisma`, `packages/db/src/index.ts`, новая миграция delivery guard.
- Discovery/recovery: `apps/worker/src/modules/source-search-plan.ts`, `collectors/olx.ts`.
- Normalization/filtering: `collectors/olx-normalization.ts`, `modules/filter-engine.ts`.
- Delivery/replay: `processors/listing-detected.ts`, `processors/observation-replay.ts`, `modules/observation-journal.ts`, `modules/telegram-service.ts`, оба Telegram formatter.
- Recovery scheduler: `apps/worker/src/index.ts`.
- UI/metrics: `apps/dashboard/app/filters/page.tsx`, `apps/api/src/routes/system-metrics-route.ts`.
- Tests: multi-category, source-search-plan, flash-format и `tests/integration/pipeline-resilience.ts`.
- README, CHANGELOG, architecture docs и этот отчёт.

Рабочая ветка содержала многочисленные более ранние изменения. Они не удалялись и не выдаются за изменения только этого продолжения. Коммит/публикация на GitHub не выполнялись.

## F. Миграции

Архитектурные: `20260904_multi_category_marketplace`, `20260904_z_multi_category_invariants`.

Текущая: `20260907_category_delivery_guard` добавляет `notificationMode`, `provisionalReasons`, CHECK(LIVE/SHADOW), восстанавливает shadow intent по старым matches без переписывания уже отправленных сообщений. Drop таблиц/vehicle-полей нет.

Всего в свежем тестовом развёртывании 38 миграций. Для отката приложения additive поля можно оставить; возврат к коду без shadow-guard допустим только с выключенными non-car фильтрами и очищенными/проверенными очередями их отправки. Восстановление старого backup в боевую БД потеряет новые наблюдения: не является штатным автоматическим rollback.

## G. Data model

Core сохраняет source/external ID/URL/title/price/currency/geo/time. `categoryKey`, version и validated JSON attributes описывают категорию. Vehicle nullable columns сохранены. Delivery intent и неопределённость теперь durable. Journal остаётся авторитетным следом принятого наблюдения; Redis claim не заменяет PostgreSQL.

## H. DiscoveryShard

Source + category + category path/ID/query + geography + planner version определяют fingerprint. Каждый scope владеет своим known tail, anchors, cutoff и окнами восстановления. Состояния защиты origin не размножаются по категориям. Ошибка передачи state от другой категории приводит к явному отказу записи, а не смене владельца строки.

## I. Search Plan Compiler

Совместимые N фильтров одной категории объединяются в discovery scope. Nationwide не сужается соседним city filter. Автомобильные контексты упорядочены первыми. Однако порядок сам по себе **не доказывает отсутствие ожидания** следующего car run из-за активного non-car запроса: отдельное ограничение нагрузки/времени shard ещё требуется.

## J. Silent internal loss

Доказаны конкретные пути: observation до Redis, восстановление после отказа очереди/БД, видимое состояние ошибки отправки, запрет shadow delivery, сохранение recovery windows и отказ чужому scope. `NOTIFIED` не заменяется поздней отметкой DUPLICATE/FAILED в outcome writer.

Это не математическая гарантия отсутствия любых внутренних ошибок. При неоднозначном Telegram timeout Bot API не предоставляет универсального idempotency key: отсутствие любых повторов в таком случае **NOT VERIFIED**. Тест DB-after-accept подтверждает видимое восстанавливаемое состояние, а не exactly-once для всех сетевых исходов.

## K. UNKNOWN

Отсутствующие характеристики, неопределённая UAH-цена и противоречивые числовые значения не становятся доказанным отказом. MAX_COVERAGE отправляет provisional warning в карточке и flash.

**STRICT urgent detail enrichment не завершён.** Сейчас STRICT не имеет отдельного полноценного urgent detail lifecycle; его наличие в schema/UI не означает выполнение всей семантики ТЗ. До реализации использовать MAX_COVERAGE/shadow. Non-car enrichment и confidence-aware market engine также требуют отдельного этапа.

## L. OLX realtime priority

Не менялись origin pacing, CAPTCHA/403 паузы, Telegram gate, worker concurrency и автомобильный polling interval. Новые категории не включались автоматически. Для non-car с непроверенным internal category ID отключён freshness API hedge без category scope. Автомобильный inference исключён из non-car normalization.

## M. Проверки

- `amb.cmd check`: PASS — security, Prisma schema/generation, docs sync, typecheck всех workspace, ESLint, PowerShell syntax, coverage tests, изолированная production-сборка API/worker/dashboard.
- Итоговый отдельный повтор unit/regression suite: **75 test files, 355 passed, 0 failed**, 07.09.2026 12:00 локально.
- `acceptance:extended`: PASS на отдельном PostgreSQL:53605 и Redis:53606; 38 fresh DB migrations. Новые проверки shadow/promotion, foreign shard, parser cutoff, cleanup и legacy re-key прошли вместе со старыми fault-сценариями.
- Зашифрованный backup: `.runtime/backups/database-20260907-115629.7z`; создан и проверен.
- `db:restore:test`: PASS — в отдельную временную БД восстановлены 1 filter и 11 listings; production не перезаписывался.
- Миграция существующей populated DB: штатный запуск применил `20260907_category_delivery_guard`, все 38 миграций применены. Проверка работающего процесса после обновления — см. приложение ниже.
- `git diff --check`: PASS.

Никакой ранее существовавший assertion не удалялся ради зелёного теста. Unit coverage не заменяет e2e: ряд processor-файлов выполняется только отдельной acceptance-программой.

## N. Performance before/after

Отдельного статистически чистого pre-upgrade набора car p50/p95 с сопоставимой нагрузкой нет. Смешанные 24-часовые агрегаты не используются как доказательство отсутствия регрессии. Полное сравнение с активным laptop shadow — **NOT VERIFIED**.

## O. Shadow

Детерминированный isolated end-to-end: ноутбук принят, сохранён, matched как UNKNOWN; обычная/повторная/flash отправка подавлена; после live reevaluation отправка одна и warning сохранён. Это не live OLX shadow: внешние freshness/overlap/request-rate характеристики ещё не измерены.

## P. Внешние ограничения

Задержки публикации/индекса OLX, ограничение страниц, удалённые между запросами объявления, CAPTCHA и HTTP 403/429 не устраняются локальной оптимизацией. Telegram acceptance не равен времени показа на телефоне. Намеренное выключение ноутбука требует последующего доказуемого catch-up, а не платного 24/7 сервера.

## Q. Оставшиеся риски и NOT VERIFIED

- Полная live/performance приёмка laptop и других категорий.
- Generic: registry/profile есть, но безопасный обязательный query/category scope и реальная e2e-приёмка не закончены. Пустой homepage-scope не считать готовым generic monitoring.
- STRICT urgent enrichment, category-specific background enrichment/market identity.
- Per-shard scheduling/backpressure и полноценная pressure telemetry. Сортировка car первой не заменяет независимое планирование.
- Parser health: нужны дополнительные fixtures изменения HTML, пустой выдачи и collapse относительно базового уровня.
- Все требования crash/fault matrix (включая crash внутри category enrichment и неоднозначный Telegram timeout) ещё не закрыты.
- Полноценные category cards Dashboard и пользовательское отображение provisional/recovery outcomes требуют UI-проверки.
- При конкурирующей смене fingerprint старое recovery history сохраняется; нужна расширенная fault-приёмка одновременного planner re-key.

## R. Следующий небольшой этап

Сначала закрыть независимый бюджет/приоритет category shard, чтобы laptop shadow физически не удерживал следующий car run. Затем bounded generic scope и STRICT/detail lifecycle. После этого включать только laptop shadow и измерять car p95, очередь, request count, overlap и protection на сопоставимых окнах. Остальные категории включать после его приёмки.

## Использованные первичные источники

- [BullMQ — Idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs): повторная обработка должна сохранять корректный конечный результат; отдельная очередь сама по себе не доказывает idempotency.
- [Prisma — Transactions](https://www.prisma.io/docs/orm/v6/prisma-client/queries/transactions): атомарность согласованных изменений. Это описание принципов, а не инструкция обновлять используемую версию Prisma.
- [Telegram Bots FAQ](https://core.telegram.org/bots/faq): ограничения отправки остаются внешними; глобальный gate сохранён.
- [OLX developer portal](https://developer.olx.ua/en): partner API не принимается за гарантированный realtime event stream всех публичных объявлений.

## Приложение: работающий runtime после обновления

07.09.2026, около 12:02 локально:

- Штатный перезапуск выполнен; API стартовал `2026-09-07T09:01:29.604Z`.
- Готовность старта 52.947 с, в том числе production build 37.536 с и servicesReady 8.358 с. Это запуск с пересборкой, не чистый boot benchmark.
- API и PostgreSQL: OK; DB latency 1 мс, pool waiting 0, connection retries 0.
- Мониторинг RUNNING; активен только один vehicle.car live filter. Новых production/shadow фильтров не создавалось.
- Hot redundancy REDUNDANT: две живые реплики, один leader, согласованный lease; background heartbeat свежий.
- OLX ACTIVE и успешный проход после обновления (`09:01:56Z`), parser-degraded shards 0.
- Все очереди на момент снимка без waiting/active/delayed; recent failures 0. Старые failed jobs сохранены: collector.run 4, collector.coverage 2, observation.replay 1. Они не удалялись ради зелёного статуса.
- Общий workers health WARN из-за внешних ограничений источников, а не отсутствия worker. RST CAPTCHA до 11.09, AUTO.RIA 403 cooldown, CARS_UA/AutoMoto LIMITED сохранены.
- Hot event-loop p95 около 31.98 мс. Текущие агрегаты category car: realtime p95 10033 мс (4382 samples), journal→Telegram p95 8383 мс (41 samples). Это смешанное историческое окно; не показатель эффекта данного деплоя и не доказательство отсутствия регрессии.
- Повторный security:check после запуска: PASS.

Итог: текущий correctness checkpoint установлен и проверен. Полное multi-category ТЗ всё ещё содержит NOT VERIFIED/незавершённые пункты из Q–R.
