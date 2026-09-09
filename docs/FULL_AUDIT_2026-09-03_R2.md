# Auto Monitor Bot — повторный аудит скорости, полноты и RST

Дата проверки: 2026-09-03. Режим: бесплатный laptop-first; выключенный ноутбук и намеренный `STOPPED` не считаются аварией. После запуска realtime обязан получить приоритет, а offline-окно восстанавливается до сохранённой доказуемой границы.

## Итоговая оценка

- Внутренняя архитектура и сохранность данных: **8.8/10**.
- Скорость внутреннего пути до первой Telegram-доставки: **7.4/10**.
- Фактическая полнота внешних источников: **6.0/10**.
- Общая готовность к цели «узнать максимально рано без скрытых пропусков»: **7.6/10**.

Нельзя технически гарантировать «всегда первый» или абсолютный ноль пропусков без разрешённого event feed от площадки. OLX официально указывает, что его API не даёт доступ к объявлениям других пользователей: <https://developer.olx.ua/ua/articles/faq>. Следовательно, момент появления объявления в публичной HTML/API-выдаче находится вне контроля проекта.

## Что проверено в живом runtime

- API, PostgreSQL, Redis, dashboard и три worker-роли запущены.
- Два hot-worker: один leader, второй standby; background вынесен отдельно.
- PostgreSQL: ответ 0–1 мс, pool waiting/retries/exhaustion равны нулю.
- Очереди waiting/active/delayed равны нулю; есть только исторические failed jobs, новых сбоев нет.
- За день: 195 journal-наблюдений, 0 unresolved, 0 pending Telegram, 0 failed Telegram.
- Offline recovery: `VERIFIED`, pending=0, unresolved=0; последняя граница закрыта backfill по реальному `CUTOFF`.
- AUTO.RIA широкая выдача теперь выполняется одним официальным search-запросом за проход, а не 11; planner показывает severity `ok`.
- Canary OLX `20±4 → 15±3` корректно сделал rollback после protection-сигнала.
- Полный gate: schema, security, typecheck, lint, PowerShell, production build и **330 тестов** прошли.

## Измеренная скорость за 24 часа

| Метрика | p50 | p95 | Вывод |
|---|---:|---:|---|
| request start → first byte | 1.824 с | 2.379 с | в основном сеть/источник |
| first byte → hot candidate | 1.150 с | 2.900 с | главный внутренний резерв в OLX parse/merge |
| hot candidate → durable journal | 13 мс | 196 мс | здорово |
| durable journal → Telegram acceptance | 546 мс | 4.918 с | текущий провал SLO 3 с |
| request start → Telegram acceptance | 3.368 с | 5.645 с | реальный внутренний hot-path |
| startup → первый успешный OLX | — | 5.913 с | быстрый запуск после включения ноутбука |

Текущий общий `collector p95=8.029 с` вводит в заблуждение: он смешивает realtime с coverage/backfill. По источникам realtime p95: AUTO.RIA 0.958 с, Cars.ua 1.392 с, OLX 5.648 с, AutoMoto 8.020 с. OLX backfill p95 около 100 с, но он работает в отдельном background-worker и может быть прерван realtime.

## Главный внешний предел

Время публикации → появление в доступном OLX-канале измеряется минутами, а не секундами:

- regional API: p50 420 с, p95 495 с (только 3 точных образца);
- public API: p50 785 с, p95 936 с (3 образца);
- regional HTML: p50 1086 с, p95 7800 с;
- public HTML: p50 2685 с, p95 11215 с.

Это не задержка worker. Это задержка доступного публичного индекса и/или семантики времени источника. Простое уменьшение polling interval ниже безопасного порога не устраняет её, но повышает шанс защиты.

## RST: подтверждённая причина и выполненное исправление

RST не имеет локальной ошибки парсера: и основной, и официальный mobile hostname с этого соединения вернули HTTP 403, `cf-mitigated: challenge` и Cloudflare Challenge Page. Cloudflare документирует `cf-mitigated: challenge` как надёжный признак защитной страницы: <https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/>. Cloudflare также прямо указывает, что остановить выдачу Challenge может владелец сайта, либо владелец может разрешить IP: <https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/resolve-challenge/>.

История RST: 18 контрольных попыток активного incident с 15 августа, последнее успешное чтение — 19 июля. Поэтому автоматическая смена URL, заголовков, fingerprint, CAPTCHA-solving или ротация IP не считается качественным исправлением.

В коде исправлено:

1. Challenge определяется по официальному заголовку Cloudflare, а HTML-pattern остаётся fallback.
2. Realtime и backfill RST используют один origin-wide Redis lock и больше не могут обращаться к RST одновременно.
3. Если realtime поставлен в текущем scheduler tick, RST backfill откладывается.
4. Фоновый RST job при конфликте не создаёт отложенный burst.
5. Пауза после устойчивой серии Challenge растёт: 24 часа → 3 суток → 7 суток; решение учитывает durable `probeAttempts`, даже если счётчик source был сброшен.

Чтобы вернуть RST-мониторинг, нужен один из разрешённых внешних сигналов: официальный API/feed, allowlist текущего IP или письменное разрешение RST на конкретный технический канал. Официальная страница поддержки публикует `editor@rst.ua` и телефоны: <https://m.rst.ua/ukr/help/feedback.html>.

## Оставшиеся слабые места и правильный порядок работ

### P0 — нет отдельного SLO первой ссылки flash bundle

`durableJournalToTelegramAcceptance` смешивает одиночные карточки, первую flash-сводку и последующие подробности. Из-за этого p95 4.918 с не отвечает на главный вопрос «когда пользователь увидел первую ссылку».

Исправление: хранить `flashAcceptedAt`, `firstLinkAcceptedAt` и `lastDetailAcceptedAt`; dashboard/SLO строить по `firstLinkAcceptedAt`. Telegram рекомендует не отправлять в один чат больше примерно одного сообщения в секунду, поэтому подробные карточки обязаны оставаться сериализованными: <https://core.telegram.org/bots/faq>.

### P0 — OLX parse/merge p95 2.9 с после first byte

Это крупнейший управляемый участок до journal. Нужен benchmark на сохранённых обезличенных response fixtures с раздельными таймерами decode, HTML extraction, merge каналов, normalization и hot-candidate callback.

Исправление: выделить page-1 hot parser, который извлекает только ID/URL/title/price/date; отправлять кандидата в journal сразу, а полную нормализацию и объединение coverage-полей делать после первой доставки. Любая оптимизация принимается только если parity-набор ID остаётся 100%.

### P0 — RST фактически не даёт покрытие

Нельзя считать источник работающим, пока status `CAPTCHA_DETECTED`; маскировать warning нельзя. До разрешённого канала RST не должен участвовать в обещании полноты.

Исправление: запросить feed/allowlist у RST. После получения — canary одного запроса с capture `cf-ray`, status/content-type и затем ступенчатый режим 10 мин → 5 мин → 2 мин только после чистой серии.

### P1 — метрика collector SLO смешивает разные lane

Фоновый backfill до 100 с делает общий p95 красным, хотя realtime не заблокирован. Это мешает верно принимать решения.

Исправление: отдельные SLO `OLX_REALTIME`, `SOURCE_REALTIME`, `COVERAGE`, `BACKFILL`; основной alarm — только на hot lane, background — по deadline/coverage progress.

### P1 — слабое интеграционное покрытие orchestration

Общее line coverage около 32%; `collector-run.ts` и orchestrator покрыты слабо. Pure-policy тестов много, но самые дорогие дефекты возникают на границах DB → Redis → worker → Telegram.

Исправление: временная PostgreSQL schema + Redis namespace + fake collector для сценариев crash/restart, protection probe, duplicate delivery, realtime-preemption, offset ceiling и restart с pending recovery.

### P1 — AutoMoto нестабилен и неточного времени недостаточно для секундного SLO

Во время аудита один проход вернул HTTP 500, а источник обычно предоставляет только день публикации. Он полезен как coverage, но не как доказательство быстрого realtime.

Исправление: оставить безопасный backoff и считать AutoMoto резервным каналом; не замедлять из-за него OLX/Cars.ua/AUTO.RIA.

### P2 — graceful shutdown

Жёсткая остановка способна оставить BullMQ job в `stalled` до штатного восстановления.

Исправление: запретить новые scheduler jobs, дождаться active hot jobs с небольшим deadline, закрыть workers/Redis/HTTP dispatcher и только затем завершать процессы.

## Следующий лучший этап

Наибольший управляемый прирост даст **P0 benchmark и разделение OLX page-1 hot parse от полного merge/enrichment**. Цель этапа: first byte → durable journal p95 ниже 500 мс при 100% ID parity, затем request start → первая Telegram-ссылка p95 ниже 4 с. Параллельно следует добавить отдельный flash-first SLO, иначе ускорение невозможно доказать.
