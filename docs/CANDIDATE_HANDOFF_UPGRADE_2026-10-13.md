# Этап 3 — передача готовых кандидатов

Цель: убрать ожидание чужой поисковой страницы после разбора собственной; измерять parse→candidate отдельно от polling, публикации источника и Telegram acceptance.

## Baseline

Read-only снимок `2026-10-12T21:04:44.649Z` (13 октября 00:04 по Киеву), окно последних 24 часов. История содержит несколько выпусков; это диагностический cohort, не непрерывный benchmark одного release. Только realtime observations; интервалы с недостающими метками отдельно посчитаны.

| Cohort | N | parsed→candidate p50 / p95 | candidate→journal p50 / p95 |
|---|---:|---:|---:|
| OLX saved-search HTML | 109 | 2191 / 5414 мс | 7 / 30 мс |
| OLX primary HTML | 123 | 12 / 37 мс | 12 / 79 мс |
| OLX primary API | 4 | 8 / 10 мс | 3 / 8 мс |
| AUTO.RIA | 143 | отсутствовали обе метки | отсутствовала candidate-метка |

У saved-search OLX candidate→Telegram acceptance p50/p95 885/2023 мс (61 полный trace); у primary HTML 1284/2757 мс (41 trace). Остальные observations не имеют acceptance; это включает неподходящие объявления, а не автоматически пропуски. Наблюдаемая задержка локализована до candidate, в накоплении savedResults.

Evidence: `.runtime/audit/handoff-baseline-20261013.json`.

## Изменения

- OLX передаёт каждую сохранённую страницу в существующий hot callback сразу после её загрузки и разбора. Раньше callback выполнялся после загрузки всех saved URLs. Последующие страницы больше не задерживают уже готовую первую.
- Существующий callback сначала сохраняет batch в durable journal, затем обрабатывает/ставит в очередь. Этот await сохраняется: сбой процесса не должен оставлять переданные карточки только в памяти. Длительная обработка callback может задержать следующий запрос; её отдельное ускорение относится к этапу Telegram.
- Сохраняются сериализация OLX HTTP, порядок запросов, дедупликация между страницами, общий candidate budget, deadline, обычный итоговый durable fallback. Первый результат остаётся доступен и при защите следующей saved-страницы.
- AUTO.RIA public сохраняет bodyReceivedAt/bodyDecodedAt, фактический parsedAt, hotCandidateAt при callback, network telemetry, channel AUTO_RIA_PUBLIC_HTML и URL target. Используются существующие поля journal, миграция не нужна.
- firstSeenAt не переопределяется: OLX сохраняет scan-time контракт, AUTO.RIA — прежний момент нормализации карточки. Начало scan хранится в CollectorRun.startedAt; реакция считается по собственным стадиям. Telegram acceptance не означает получение push на телефоне.

## Проверки

Регрессия моделирует вторую страницу на 5 секунд позднее: первая передаётся до её запроса, parsed→candidate в детерминированном сценарии 0 мс. Проверены дубли внутри/между страницами, общий лимит 2, защита второй страницы, сохранение firstSeenAt. AUTO.RIA тест проверяет timestamps до медленной saved-страницы и отсутствие повторного handoff известной карточки. Существующие collector-run tests проверяют retry обычным durable путём при отказе hot callback и отсутствие повторной обработки после успешного callback.

Полный release gate прошёл: **138 файлов / 865 тестов**, vitest без stderr; types, lint, coverage, schema/docs, PowerShell, backup/CI policy и isolated production build. Commit `5a54641cca0cdd23c001ff9f75aa0da476ad3094`. Цель p95 ≤500 мс для готового самостоятельного feed требует новых production observations; синтетический тест не является обещанием production p95.

## Выпуск и LIVE

Accepted release `5a54641cca0c-20261012210907`. LIVE возобновлён 13 октября в 00:09:34 по Киеву (`2026-10-12T21:09:34.367Z`). Проверка в 00:10:36: ожидаемая ревизия, API OK, RUNNING, 2 активных источника, consecutiveErrors=0, новых FAILED/RATE_LIMITED/CAPTCHA_DETECTED нет. OLX: два завершённых realtime scan 11,319/9,243 с, gap 16,2 с при 20±4 с. AUTO.RIA: 0,494/0,681 с, gap 58,4 с при 60±5 с. Retention OK, due/overdue/invalid/unmanaged=0. AUTO.RIA LIMITED — прежняя novelty caveat.

За короткое окно после выпуска новых realtime observations с новым requestStartedAt не появилось. Поэтому production parsed→candidate p95 и новые AUTO.RIA traces после изменения пока не подтверждены. Это ограничение выборки, не повод считать старые timestamps результатом нового выпуска. Проверка успешных запросов и regressions завершена; end-to-end отправка нового объявления на телефон не измерялась.

Evidence: `.runtime/audit/handoff-live-after-20261013.json`, `.runtime/audit/handoff-traces-after-20261013.json`; scratch `handoff-check-20261013.log`, `handoff-release-build-20261013.log`.

Следующий этап — первая Telegram-реакция, fairness получателей и flash/tail при burst. Отдельно оценить время, которое текущий durable hot callback проводит в inline обработке до запуска следующего saved-search request.
