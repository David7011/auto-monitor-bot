# Аудит перехода к multi-category marketplace monitor

Дата: 04.09.2026.

## Исходное устройство

До изменения pipeline был crash-aware и быстр для автомобилей: source discovery, normalization, durable observation journal, Redis claim, vehicle filter, ранний Telegram send, затем enrichment. Realtime, coverage и backfill были разделены; OLX имел централизованные pacing/protection и active/standby hot worker. Основная архитектурная проблема состояла не в очередях, а в сквозном предположении `Listing = Vehicle`.

## Найденные зависимости от автомобиля

- OLX path/category ID были жёстко привязаны к легковым автомобилям.
- Filter/Prisma/Telegram/market/dedupe ожидали year, mileage, VIN, plate, engine, gearbox и USD price.
- Continuity state не содержал явной category identity.
- Один широкий public context не мог безопасно разделять car и electronics known tails.
- Отсутствующее поле электроники могло быть интерпретировано как false и потеряно.
- HTTP 200 и пустой parse не имели достаточно явного per-shard semantic health.
- Dashboard начинал форму с марки автомобиля и показывал vehicle-only поля для любого фильтра.
- Изолированный fault stand использовал `db push` и не доказывал свежую последовательность migrations.

## Принятые решения

1. Additive migration вместо удаления vehicle columns.
2. Versioned category registry и validated JSON attributes вместо giant nullable table.
3. Явные source capabilities: OLX multi-category, остальные production sources vehicle-only.
4. Category-owned DiscoveryShard fingerprint и state; origin coordinator остаётся общим.
5. Один discovery на категорию с N local filter evaluations; car shard сортируется первым.
6. Tri-state filtering с `MAX_COVERAGE` по умолчанию.
7. Vehicle-only strong identifiers не применяются к электронике.
8. Per-filter shadow mode, без автоматического live-включения новых категорий.
9. Semantic parser health блокирует ложное подтверждение coverage.
10. Production migration path проверяется на пустой изолированной PostgreSQL.

## Отклонённые варианты

- Отдельные копии `olx-laptop.ts`, `olx-phone.ts`: дублировали бы protection/recovery и увеличили риск расхождения.
- Один запрос на пользовательский фильтр: линейно увеличивал бы OLX request rate.
- Угаданные OLX internal IDs: могли бы молча смешать категории; до официальной проверки используется HTML path.
- AI/OCR/detail cascade перед Telegram: ухудшал бы latency и crash surface.
- Автоматическое включение всех новых категорий: не даёт доказать отсутствие влияния на car hot lane.
- Soft-title dedupe как suppressor: создаёт false positives для одинаковых товаров разных продавцов.

## Проверяемые границы

Внутренняя цель сформулирована как ZERO SILENT INTERNAL LOSS. Абсолютная внешняя полнота не доказуема без official event stream. `UNKNOWN`, `PARSER_DEGRADED`, `PROTECTION_PAUSED` и `UNRESOLVED_EXTERNAL_LIMIT` должны оставаться видимыми и не превращаться в зелёный verified state.
