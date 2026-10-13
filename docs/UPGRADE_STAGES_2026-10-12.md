# Поэтапный upgrade Auto Monitor Bot

**Текущий пакет 13.10, обновление 17:15 Kyiv:** [этап 1 — OLX outage start](OLX_OUTAGE_START_UPGRADE_2026-10-13.md) и [этап 2 — Telegram first-signal](TELEGRAM_FIRST_SIGNAL_UPGRADE_2026-10-13.md) реализованы. Текущая проверка: 139 файлов / 887 тестов, types/lint и изолированный Telegram PostgreSQL/Redis stand прошли. Хотя ранее выпуск был отложен до этапа 3, read-only `/health` уже подтвердил работающую ревизию `23b5e70`, выпущенную вне текущей проверки. Здесь выпуск и перезапуск не выполнялись. После смены бота один из двух подписчиков получает `chat not found`; доставка всем в LIVE пока не подтверждена. Далее — AUTO.RIA public catch-up. Прежние номера ниже относятся к истории предыдущих выпусков.

Приоритет: первая полезная реакция на новое подходящее объявление, полнота поиска и доступность мониторинга. Chromium sandbox settings и challenge automation сохранены.

**Уточнение 13.10.2026:** новый [глубокий аудит](DEEP_AUDIT_2026-10-13.md) подтвердил ложные OLX outage windows при своевременном запуске и разрыв первого Telegram-сигнала между получателями до 25,4 с. Актуальный порядок: исправление определения outage → быстрый Telegram-сигнал всем получателям → AUTO.RIA public catch-up → ускоренный durable replay → устранение ожидания Telegram внутри collector callback при подтверждённой задержке → эксперимент AUTO.RIA 30 с. Панель/enrichment/общие оптимизации ниже в очереди, пока не доказан выигрыш от 5 секунд. Нумерация ниже сохраняет историю предыдущего плана; новые пункты ещё не реализованы. Отдельно требуется непрерывная работа хоста: 13.10 подтверждён двухчасовой сон Windows по причине Battery.

## Завершено ранее

**P0 retention:** исправление выпущено; исходные 283/283 уведомления очищены, 283 dedupe tombstones сохранены, исходный backlog/invalid/error = 0.

## Этап 1 — AUTO.RIA public 60 секунд

Статус: **выпущено и проверено в LIVE**. Commit `3c310f2787c44a363a4b09a2601736df57c4fe5a`, release `3c310f2787c4-20261012172412`.

Причина: `autoRiaLiveIntervalSeconds()` при запуске LIVE вычислял interval из hourly API limit даже в public режиме. При quota=30/hour сохранялось 120 секунд. Scheduler затем корректно использовал уже завышенную сохранённую величину.

Исправление: public сохраняет `LIVE_AUTO_RIA_MIN_INTERVAL_SECONDS` (текущая настройка 60). Official API сохраняет свой quota calculation; scheduler по-прежнему учитывает contexts и detail reserve для API. Существующий jitter ±5 секунд сохранён. Это 60 секунд nominal cadence, не обещание ровно 60,000 секунды между каждым началом scan.

Проверки: regression сначала воспроизвела 120 вместо 60; затем public LIVE/repeated LIVE, API quota/context reserve и сохранение active pause. Полный gate и проверка нескольких фактических сканов нового release обязательны. Baseline: семь успешных public scan, gaps 117,8–124,5 секунды, ошибок 0.

Результат release gate: **133 test files / 834 tests**, types/lint/coverage/PowerShell/schema/docs и isolated production build прошли. Выпуск из clean tracked checkout; предыдущие untracked материалы сохранены. Production подтверждает новую ревизию, `RUNNING`, 2 active sources, intervalSeconds=60, jitterSeconds=5, consecutiveErrors=0. Три завершённых public скана после LIVE resume дали интервалы **57,9 и 62,5 секунды**. Retention `OK`, due/overdue/invalid=0. Статус AUTO.RIA `LIMITED` содержит прежнее пояснение о недоказанном времени публикации; это не rate limit и не ошибка скана.

Проверка запуска короткая; она доказывает применение интервала, а не длительную устойчивость источника или доставку нового объявления на телефон. Evidence: `.runtime/audit/aria60-before-20261012.json`, `.runtime/audit/aria60-after-20261012.json`. В этом окне новые объявления не появились; source HTTP и cadence подтверждены, отправка проверена регрессионной suite.

## Этап 2 — OLX recovery

Изменения выпущены: evidence v2, обработка изменившегося overlap, общий проход overlapping windows, durable cursor/backoff, retry после surviving lease и устранение голодания фонового слота. Финальный commit `a4a24a50bd06e55a96ce77227726d1e2ee5c3a9d`, release `a4a24a50bd06-20261012210057`. Полный gate: 137 файлов / 862 теста; отдельный recovery-only PostgreSQL/Redis acceptance прошёл. Исторические окна с реально изменившейся пагинацией остаются UNRESOLVED; выпуск не означает доказанную полноту недоступной истории. Подробные изменения, LIVE evidence и пределы проверки: [отчёт этапа 2](OLX_RECOVERY_UPGRADE_2026-10-12.md).

## Этап 3 — передача готовых кандидатов

Выпущен commit `5a54641cca0cdd23c001ff9f75aa0da476ad3094`, release `5a54641cca0c-20261012210907`. Baseline локализовал задержку OLX saved-search: parsed→candidate p95 5414 мс против 37 мс у основной HTML-ленты. Saved-страницы теперь передаются по готовности; AUTO.RIA public получил отдельные parse/candidate/network метки. Полный gate: 138 файлов / 865 тестов. Production p95 после изменения требует новых observations; ограничения и runtime-проверка в [отчёте этапа 3](CANDIDATE_HANDOFF_UPGRADE_2026-10-13.md).

## Этапы, которые останутся

| Этап | Изменение | Критерий завершения |
|---|---|---|
| 4 | Первая быстрая реакция Telegram, fairness получателей, flash burst/tail | быстрый signal всем recipients; tests 1/2/20/21/100, 429/timeout/crash без дублей |
| 5 | Панель: streaming events, компактный list DTO, лёгкие status/metrics snapshots | событие→видимая панель целевой ≤0,5 с локально; reconnect без потерянных событий |
| 6 | Enrichment: single-flight phone/market, coalescing updates, независимый retry optional enrichment | меньше одинаковых внешних calls/edits; первая отправка не ждёт enrichment |
| 7 | Retry/replay и cleanup: задержки по типу ошибки, пакетная/age-aware очистка, Redis lifecycle CLI | свежая durable работа восстанавливается быстрее; retention/replay без бесконечной повторной работы |
| 8 | Hot/background resource budgets и AUTO.RIA saved-search dedupe/concurrency cap | realtime p95 не растёт на фоне burst/backfill; source protection остаётся согласованной |
| 9 | Схема/контракты/capabilities и product dedupe semantics | effective public/API capabilities честны; DB/status contracts проверены; новое объявление не скрывается ненужным similarity match |
| 10 | Windows IPC, DB query plans/bulk writes, filter compilation и operations | отдельные измеренные ускорения, прогнозируемые release/failover; без общей перестройки ради недоказанного выигрыша |

Первоначально следующим был этап 4; после аудита 13.10 перед ним стоит короткое исправление ложного определения OLX outage. Затем основной измеренный резерв — первая Telegram-реакция всем получателям. Этап панели отдельно ускоряет визуальный отклик и отложен согласно новому порогу эффекта. Каждый этап: baseline → ограниченное изменение → регрессии/полнота → release → runtime evidence. Экспериментальные latency targets не являются текущими гарантиями.

Подробнее: [полный аудит](FULL_PERFORMANCE_AUDIT_2026-10-12.md).
