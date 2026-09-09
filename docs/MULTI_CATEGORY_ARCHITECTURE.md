# Multi-category marketplace architecture

Дата: 04.09.2026. Schema version: 1. Search planner version: 6. Observation normalizer: 4.

Контрольная проверка 07.09.2026: [статус A–R и незавершённые требования](MULTI_CATEGORY_CHECKPOINT_2026-09-07.md). Этот документ описывает направление архитектуры; он не заменяет live-приёмку всех категорий.

## Контракт

Критический путь остаётся коротким:

`source response → cheap normalization → durable SourceSeenListing → hard dedupe → cheap tri-state filter → Telegram acceptance`

Detail HTTP, OCR, AI, vehicle checks и market analysis выполняются после первой отправки. Для non-vehicle объявлений автомобильные enrichment jobs не создаются.

## Domain model

Core-поля объявления остаются общими. Вертикальные данные находятся в `categoryAttributes` JSONB/Json и проверяются allow-list validator перед использованием. `categoryKey` и `categorySchemaVersion` присутствуют в filter, listing, observation и search state. Старые nullable vehicle columns сохранены для обратной совместимости.

Поддерживаемые ключи:

- `vehicle.car`
- `electronics.laptop`
- `electronics.phone`
- `electronics.desktop`
- `electronics.component.gpu`
- `gaming.console`
- `transport.escooter`
- `generic`

## Discovery shard

Устойчивый fingerprint строится из source, category, закреплённого source path/ID/query, geography, discovery параметров и planner version. Каждый fingerprint владеет своим known tail, anchors, cutoff, parser health и recovery state. OLX pacing и protection при этом остаются origin-wide и не размножаются по shards.

Search Plan Compiler детерминированно группирует совместимые фильтры. Для OLX и других публичных источников один category/geography discovery обслуживает N локальных filter evaluations. `vehicle.car` всегда имеет первый приоритет. AUTO.RIA сохраняет узкие API-контексты с официальными маркой/моделью и принимает только vehicle filters.

## Tri-state filtering

- `MATCH`: все заданные условия доказаны.
- `NO_MATCH`: существует доказанное противоречие.
- `UNKNOWN`: листинг потенциально подходит, но характеристика отсутствует или не подтверждена.

`MAX_COVERAGE` отправляет `UNKNOWN` как provisional match. `STRICT` сохраняет тот же наблюдаемый outcome и не отбрасывает объявление; полноценный urgent detail refinement является отдельным следующим этапом и не реализуется скрытым сетевым каскадом в обычном hot path.

Причины UNKNOWN сохраняются в `Listing.provisionalReasons` и выводятся в первой карточке/flash. Для электроники бюджет — UAH; неизвестная валюта, отсутствующая география/характеристики и противоречивые числовые значения остаются UNKNOWN. Автомобильная USD-фильтрация не меняется.

Shadow — durable delivery intent (`notificationMode=SHADOW`), а не только ветка в памяти collector. Повторные card/flash send подавлены; смена фильтров запускает повторную оценку. Только положительный live-match разрешает продвижение в LIVE.

При эквивалентном изменении версии planner сохраняется ID строки search state и связанные recovery windows. Cleanup не удаляет строки с recovery history. Смена марки AUTO.RIA, географии или категории не считается эквивалентным scope. На самой границе записи проверяются source/category/fingerprint; DEGRADED не может подтвердить cutoff даже при противоречивых флагах вызывающего кода.

## Dedupe

Hard identity: `source + externalId`, canonical URL и доказанные vehicle VIN/plate правила. Неавтомобильные совпадения по title/model/price являются только возможной похожестью и не подавляют первое уведомление.

## Parser and coverage truth

OLX HTTP 200 считается семантически успешным только при ожидаемых structural markers и достаточном отношении валидных ID/URL. `PARSER_DEGRADED` не продвигает proven cutoff. Недостижимая внешняя граница остаётся durable `UNRESOLVED`, а realtime продолжает работать независимо.

## Rollout

Новые категории включаются по одной. Рекомендуемый первый этап — laptop filter с `shadowMode=true`. Перед live Telegram сравниваются car p95, queue delay, protection events, request count, overlap/recovery, parser health, CPU/RAM и DB/Redis load. Проект не создаёт новый production-фильтр автоматически.

## Ограничения

Новые OLX внутренние category IDs намеренно не зафиксированы без ответа аутентифицированного официального categories endpoint. Закреплённые публичные пути не позволяют пользовательскому вводу менять origin и снижают риск SSRF. Внешняя задержка индекса, CAPTCHA, 403/429 и pagination limits остаются наблюдаемыми ограничениями, а не внутренней гарантией полноты.
