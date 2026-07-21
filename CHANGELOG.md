# Changelog

## 2026-07-22 v0.4.0 — автономный supervisor, доказуемое покрытие OLX и platform upgrade

- Одноразовый boot launcher заменён долгоживущим `SYSTEM`-супервизором: он проверяет критическую готовность, устраняет ложный провал фиксированных «8 секунд» и автоматически восстанавливает процессы. Задачи запускаются при boot и logon, а файловые lock-и безопасно объединяют дубли.
- Fast Startup/гибернация отключены: следующий запуск ноутбука является настоящей загрузкой Windows, а на C: освобождено около 6,1 ГБ. Сон S3 сохранён.
- OLX HTML, regional и owner/private coverage получили независимые per-fingerprint интервалы и паузы в PostgreSQL. Private shadow не удваивает четырёхсекундный hot path; каждый `CollectorRun` хранит структурированные метрики каналов.
- Добавлен прямой parity-тест OLX. Финальный контрольный прогон подтвердил 213/213 ID; owner/private lane дал 47 ID, а HTML lane ещё 3 ID, отсутствовавших в текущей fast-выдаче, но уже известных системе.
- Ошибки дедуплицируются по fingerprint со счётчиками и первым/последним временем. 19 352 исторических события сведены в 1 252 записи без потери количества повторов.
- Collector runs старше 7 дней сначала агрегируются почасово. При первом maintenance 18 827 запусков сведены в 174 агрегата; legacy observations без snapshot и orphan search state очищаются транзакционно.
- Бэкап получил optional mirror на другой том/UNC. Добавлен реальный restore drill во временную БД и еженедельная `SYSTEM`-задача; тест восстановил 2 фильтра и 942 объявления.
- Next.js обновлён до 16.2.11: `middleware` мигрирован на `proxy`, Turbopack production build проходит без предупреждений. Prisma обновлён до 7.9.0 с `prisma-client`, `prisma.config.ts` и PostgreSQL driver adapter.
- Dashboard session больше не использует `LOCAL_API_TOKEN` как fallback; журналы показывают дедуплицированные occurrence count.
- Безопасные patch-релизы зависимостей обновлены; production audit, TypeScript, lint, unit/integration, E2E, Android и runtime recovery проверяются полным набором команд.
- Fault injection подтвердил восстановление принудительно завершённого API новым supervisor за 44 секунды.
- Android release metadata теперь читается из фактически собранного APK, поэтому JSON-манифест не может остаться на старой версии при обновлении `build.gradle`.
- Tailscale HTTPS был проверен, но аккаунт отвечает `account does not support getting TLS certs`; сохранён приватный TCP внутри WireGuard tailnet без публичного firewall-порта.

## 2026-07-21 v0.3.0 — полнота OLX, hardening и автономная эксплуатация

- OLX pagination больше не останавливается на одиночной старой/promoted карточке; cutoff и overlap фиксируются только при доказанной границе, а ошибки фида и candidate overflow не создают ложный успех. Безопасно классифицированные ID сохраняются в cursor-state: штатный цикл сокращён с 5 страниц/10 запросов/~2,6 с до 1 страницы/2 запросов/~0,5 с.
- Добавлены регрессии mixed promoted/fresh, all-old cutoff, overflow, worker health, query validation и расширенная SSRF-защита.
- `/health` показывает состояние каждого целевого источника, `/metrics` — задержки по источникам; внешний сбой источника больше не запускает watchdog restart-loop.
- `/listings`, `/listings/recent` и `/logs` получили строгие пределы и cursor pagination.
- Dashboard login rate limit перенесён в Redis; client fingerprint хешируется на BFF, сбой limiter обрабатывается fail-closed.
- Telegram control polling использует exponential backoff с jitter и подавлением повторного outage-log.
- Node 24.18.0, Android tools, Microsoft OpenJDK 17 и Gradle 9.3.1 загружаются из официальных источников с SHA-256; CI actions закреплены по commit SHA.
- Добавлены AES-256 бэкапы PostgreSQL с `pg_restore --list`, `7z t`, SHA-256 metadata, retention и ежедневной `SYSTEM`-задачей.
- ACL проекта закрыты для текущего пользователя, Administrators и SYSTEM; автозапуск проверяет ACL и выполняется только при boot, без повторного запуска при logon.
- E2E автоматически создаёт и удаляет временного dashboard-пользователя и сохраняет реальный exit code Playwright.
- Удалены старые приватные ZIP-архивы; создание нового ZIP с секретами запрещено.
- Безопасная очистка C: удалила только устаревший Temp, crash dumps и пересоздаваемые Gradle/Playwright/shader caches.

## 2026-07-17 Cars.ua/OLX апгрейд, аудит-фиксы, Android 1.2.0

- Cars.ua: realtime теперь листает адаптивно до пересечения с известными объявлениями (`CARS_UA_REALTIME_MAX_PAGES`, `CARS_UA_MAX_NEW_PER_RUN`) с сентинелом переполнения — всплески не теряются на этой быстрой площадке.
- OLX: опциональный режим «поднятых» (`OLX_INCLUDE_REFRESHED`, по умолчанию выкл) — считает свежеподнятое объявление кандидатом по новейшей из `created_time`/`last_refresh_time`, ловит перевыставления и снижения цены.
- Дедуп: `sellerPhone` больше не strong-ключ — телефон идентифицирует продавца, а не машину, поэтому разные авто одного дилера под одним номером больше не глушатся (устранён реальный источник пропусков).
- Полнота: исправлен фильтр Prisma `JsonNull` → `DbNull` в observation-replay (SQL-NULL строки больше не протекают в набор повтора, не помечаются FAILED и не голодят гидрацию).
- Парсинг: `parseEngineVolume` больше не читает «150 л.с.» как объём; `decodeHtmlEntities` декодирует `&amp;` последним и поддерживает астральные код-поинты; классификация «газ / бензин» больше не путается с бензином (выбор по самому длинному алиасу + кэш нормализованных алиасов).
- Устойчивость/эффективность: общий дедлайн скана на все контексты (лок не переполняется на multi-context источниках); `detectorForBody` вызывается один раз на ответ; обновление Telegram-сообщения читает БД тремя параллельными запросами; сравнение цены в possible-dup только с исходным полем валюты.
- Dashboard: таймеры тостов больше не сбрасываются на каждом рендере; форматтер часов вынесен из тика; линии фона отбраковываются по квадрату расстояния (sqrt только для близких пар); максимум по контурам считается один раз.
- Android поднят до 1.2.0 (versionCode 3): нативные цвета тулбара/оффлайна синхронизированы с новым дизайном дашборда, UA обновлён. APK пересобирается на рабочей машине командой `pnpm android:build`.
- Добавлены регрессии на классификацию топлива, объём двигателя и декодирование HTML-сущностей. Полный набор: typecheck, lint (0 предупреждений), 89 unit-тестов, production-сборки — зелёные.

## 2026-07-17 Полный редизайн dashboard (премиум UI/UX)

- Новая дизайн-система на CSS-токенах: графит + тёплый янтарь, слои поверхностей по глубине, матовое стекло, тени, свечения, motion-easing. Легаси-имена токенов сохранены — не переделанные части не ломаются.
- Живой фон: canvas-частицы с линиями связи + сетка + виньетка. Перф-гейт (`useEffectTier`) авто-упрощает/выключает эффект на слабых устройствах, тач-мобайле и при `prefers-reduced-motion`; RAF throttling ~40fps и пауза на скрытой вкладке.
- Переиспользуемый UI-kit: `HudPanel`/`MetricCard`/`GlowButton`/`RadarRing` подняты на месте (обратная совместимость), плюс `Gauge`, `AnimatedNumber`, `MeterBar`/`StackedBar`, `LiveDot`, `Skeleton`, `Segmented`, `DataTable`, система тостов (Framer Motion), `LiveFeed`/`VehicleCard`, `SourceCard`.
- Оболочка: стеклянный сайдбар со скользящим активным индикатором (layoutId), живой статус ядра, топбар с часами, плавные переходы страниц, обновлённая мобильная навигация и drawer.
- Флагман «Пульт»: hero, боевая готовность с радаром и gauge, KPI-грид с анимированными числами, панели скорости (meter-бары к таргетам) и покрытия (stacked bar + контуры), здоровье источников, диагностика, очереди, Live Feed с анимацией появления новых карточек сверху.
- «Источники» как центр управления: карточки с монограммой, gauge здоровья, откликом/найдено/порядком, живыми индикаторами; инциденты и история — на новом `DataTable`.
- Прокатка системы на Фильтры (премиум-контролы, чипы, тосты), Объявления (переключатель «Плитки/Таблица»), Логи (фильтр уровней), План (DataTable контекстов), Настройки, Логин.
- Гибридный подход к 3D: тяжёлый Three.js не добавлялся (производительность в приоритете, бандл лёгкий, ничего не ставится на диск C). Опциональная 3D-сцена-герой — отдельным этапом.
- Проверки: dashboard typecheck и production build (12 страниц) зелёные; страница логина отрендерена в реальном браузере без ошибок консоли; мониторинг OLX не прерывался.

## 2026-07-17 OLX realtime completeness and anti-block upgrade

- OLX realtime scans now paginate adaptively until they overlap already-known listings or the freshness cutoff (up to `OLX_REALTIME_MAX_PAGES`), so publication bursts between two scans can no longer be lost.
- OLX API page size raised to the verified maximum of 50 (`limit <= 50`, ~65 adverts per page with promoted extras); backfill depth capped at the verified `offset <= 1000` limit (20 pages x 50), removing wasted 400 responses and HTML fallbacks on deep pages.
- Backfill stops early once a full page is past the freshness cutoff, saving request budget on every five-minute deep pass.
- A realtime overflow sentinel records a semantic warning when a scan exhausts its page budget without overlapping known listings — a direct "possibly missed adverts" indicator visible in collector runs and source status.
- Rate-limit pauses now honor the `Retry-After` header and grow exponentially (90 s base, capped by `RATE_LIMIT_PAUSE_MAX_SECONDS`) instead of a flat 15-minute pause; captcha pause is configurable via `CAPTCHA_PAUSE_SECONDS`.
- The optional private-sellers pass (`OLX_PRIVATE_FEED_ENABLED`, API `owner_type=private`) replaces the dead `OLX_SEARCH_URL`/`OLX_EXTRA_SEARCH_URLS` config that no code path consumed.
- Source requests use a realistic browser User-Agent by default and OLX requests send a Referer; the OLX realtime interval is 4 s with 1 s jitter (also updated in the live database row).
- Added regressions for known-ID overlap detection, page-size offsets, private feed targets and protection pause math.

## 2026-07-14 Observation journal and completeness audit

- Every normalized source candidate is now stored before filtering with its source snapshot, discovery lane, timestamps and normalizer version.
- Filter decisions now include matched filter IDs and explicit rejection reasons; rejected adverts can be replayed after filter changes.
- Added the isolated `observation.replay` queue, periodic completeness audits and Telegram controls for completeness status and manual replay.
- OLX legacy rows without a snapshot are recovered from their detail pages with bounded concurrency, retry cooldown and realtime-safe deduplication bypass.
- The replay path preserves the original publication timestamp and no longer allows Redis hot claims to hide unresolved observations.
- Market estimates now use the full observation corpus instead of only previously matched adverts.
- USD conversion refreshes from the official NBU API and keeps the configured fallback when the provider is unavailable.
- Startup now uses an exclusive lock, interrupted pipelines are recovered, stale runs are closed and operational history has bounded retention.
- System diagnostics are shown in Russian, while LIVE latency metrics exclude background-recovery notifications.
- Final acceptance: Prisma, TypeScript, ESLint, 68 unit/integration tests, production builds and 4 authenticated Playwright scenarios passed.

## 2026-07-14 OLX completeness recovery

- OLX collection now uses the smaller public JSON feed first and retains HTML as a fallback.
- Dnipro and Samar are requested as separate geo-scoped feeds instead of collapsing all active filters into one Ukraine-wide feed.
- Promoted or refreshed old ads no longer stop a newest-first scan; every card on the page is inspected before the collector decides whether the date cutoff was reached.
- OLX backfill now scans up to 30 source-specific pages every five minutes while the five-second realtime lane remains limited to the first page.
- Explicit OLX fields such as `cleared_customs`, engine volume and power are normalized from structured API parameters.
- Filtered-out candidates release their temporary Redis hot claim so a corrected normalizer or filter can replay them safely.
- Active filters use the `TODAY` window to cover all matching listings published since midnight in Kyiv.
- Added regressions for old promoted ads before fresh ads, Dnipro/Samar API URLs and structured customs status.

## 2026-07-13 Финальный realtime/backfill hardening

- Планировщик переведен с фиксированного pulse на ожидание ближайшего срока источника (100-1000 мс).
- Добавлены независимые очереди `REALTIME` и `BACKFILL`: быстрый проход имеет приоритет, глубокий восстанавливает дополнительные страницы раз в 10 минут.
- Добавлены дедлайны, лимиты страниц/кандидатов, коалесинг конфликтующих запусков и изоляция ошибок глубокого прохода.
- Добавлен горячий Redis-барьер дублей; PostgreSQL остается окончательной гарантией уникальности.
- AUTO.RIA использует атомарный месячный счетчик и скользящий часовой лимит; отложенный запрос по квоте больше не считается CAPTCHA.
- RST и AutoMoto поддерживают безопасное определение нового объявления по первому появлению в realtime без рассылки старых записей из backfill.
- Метрики разделяют realtime, восстановленные записи, задержки обнаружения/Telegram и здоровье каждого источника.
- Telegram учитывает `retry_after`, прекращает бессмысленные повторы для удаленного аккаунта и не редактирует сообщения старого chat ID.
- Production-процессы запускаются напрямую через Node с точными PID. Стоп больше не затрагивает посторонние приложения.
- SYSTEM-автозапуск и watchdog переведены на совместимые launcher-файлы и проверены реальным запуском/принудительным падением API.
- Мобильный E2E расширен до всех экранов на viewport 430x932; планировщик и служебные предупреждения переведены на русский.
- Приватная упаковка умеет включать `.env` и проверяемый custom-format дамп PostgreSQL, исключая runtime, зависимости и кэши.

## 2026-07-13 Realtime Pipeline, Geography and Vehicle Intelligence

- Removed the Telegram channel reader, legacy source tables and user-session path.
  Telegram remains only for private alerts and bot-based control.
- Added official KATOTTG city coverage, Telegram region/city selection and AutoMoto.ua backup discovery.
- Added photo OCR for VIN/plate extraction and parallel official NHTSA checks.
- Upgraded the project Redis runtime from incompatible Redis 3 to Redis 8.8 on port 6380.
- Added real Redis/BullMQ version diagnostics and stopped masking queue failures as zeros.
- Added SYSTEM startup before user logon and a one-minute health/process watchdog.
- Moved Playwright browsers to `D:\auto-monitor-bot\.runtime` and upgraded Playwright/PostCSS
  to patched versions; production dependency audit now reports no known vulnerabilities.
- Fixed mobile filter action overflow and retained JSON-safe empty POST bodies.

## 2026-07-11 Stage 27 Speed / Market Price / VIN Intelligence

- Added fast inline Telegram send path after listing persistence. This removes
  the extra `telegram.send` queue hop on the hottest path while keeping the
  queue as fallback.
- Duplicate listings that already exist but have no completed Telegram
  notification now re-trigger the first notification path instead of silently
  returning.
- Worker queue concurrency is now configurable through env vars and defaults
  are higher for Telegram/event/listing pipelines.
- Scheduler pulse is now configurable and defaults to 1000 ms for tighter due
  source dispatch.
- LIVE source intervals are configurable through env vars. Default OLX polling
  is faster, while AUTO.RIA remains protected by quota-derived minimum interval.
- Added `market_price_estimates` table and market estimate pipeline.
- Background enrichment now computes local comparable market prices, saves
  sample size, average, median, quartiles, fair range and verdict.
- Telegram messages now show market status/range/verdict after the first
  background update.
- Listings dashboard now shows market verdict and median price.
- Vehicle checks now store decoded make, model, year, engine volume, fuel,
  body, drive, provider and discrepancy list.
- Added free NHTSA vPIC VIN decode in background when VIN is available.
- Vehicle check compares listing claims against decoded VIN specs and reports
  mismatches in the same Telegram message.
- Added unit coverage for market price verdicts and insufficient-data behavior.
- No CAPTCHA bypassing or automated CAPTCHA solving was added.

## 2026-07-11 Stage 26 Production Hardening

- Added real TypeScript production builds for `packages/shared`, `packages/db`,
  `apps/api` and `apps/worker`.
- `pnpm local:start` now runs production services: compiled API, compiled
  worker and `next start` dashboard. Watch/dev startup moved to
  `pnpm local:dev`.
- Startup/stop/status scripts now support `PROJECT_ROOT`, `POSTGRES_BIN`,
  `POSTGRES_DATA`, `POSTGRES_PORT` and `REDIS_PATH` overrides.
- `pnpm local:stop` now stops production command wrappers and their child
  Node.js processes, so API/worker/dashboard do not stay alive after stop.
- Added central worker `SourceHttpClient` with timeout, response byte limit,
  content-type validation, request ids, retry-after parsing and source response
  classification.
- HTML collectors and AUTO.RIA now use the central source HTTP client.
- Dashboard BFF now supports `PUT`, enforces `BFF_MAX_BODY_BYTES`, keeps
  server-side bearer injection and returns structured oversized-body errors.
- Empty mutating BFF requests without `content-length` are treated as `{}`,
  covering manual/CLI STOP calls with `Content-Type: application/json` and no
  body.
- Added shared source capability metadata for access mode, scheduler mode,
  realtime support, newest-first guarantees and anti-bot risk.
- `/monitoring/status` now returns source capabilities for dashboard/runtime
  diagnostics.
- Added `challenge_incidents` persistence for CAPTCHA/challenge/rate-limit and
  access-denied states with redacted metadata.
- Sources dashboard now includes an Incident Center for latest challenge
  incidents.
- Added unit coverage for source HTTP classification, response size limits,
  JSON parsing and source capability contract.
- No CAPTCHA bypassing or automated CAPTCHA solving was added. The compliant
  behavior remains detection, cooldown and incident recording.
- No ZIP/archive was created during this stage.

## 2026-07-10 Hardening

### Live Monitoring / AUTO.RIA Geo / Social Inbox

- Added strict `LAST_24_HOURS` rolling-window handling: cutoff is always `now - 24h`, current batches are sorted `publishedAt DESC`, and listings without reliable publication dates are excluded from this mode.
- Added deterministic newest-first tie-breakers by `publishedAt`, source priority and `externalId`.
- Added `newestFirstVerified` source capability and SourceSearchState watermarks/cursors for latest seen, oldest scanned, completed cutoff and realtime/backfill cursor metadata.
- AUTO.RIA search now uses the required official newest-first parameter `order_by=7` with `searchType=4`, `status_id=0` and `page=0`.
- Realtime listing and Telegram send jobs now use priority `1`; enrichment/background work stays lower priority.
- Added configurable initial window behavior: default `SKIP_EXISTING`, optional capped `NOTIFY_MATCHING_IN_WINDOW`.
- Dashboard Sources/Planner now expose verified `NEWEST FIRST` versus local-sort/unverified source order and rolling 24-hour state.
- Added unit coverage for rolling 24-hour cutoff, TODAY difference, newest-first order, UNKNOWN timestamp exclusion, stable tie-breaks and refreshedAt not acting as publishedAt.
- Added compliant anti-bot guard: stronger CAPTCHA/Cloudflare/rate-limit detection, source cooldown and dashboard health signal. No CAPTCHA bypass or auto-solving is implemented.
- LIVE mode now derives the AUTO.RIA polling interval from the configured hourly quota, keeping OLX/Cars.ua/RST fast while avoiding aggressive API retries.
- Starting LIVE mode preserves active source cooldowns, so a paused AUTO.RIA/RST/OLX source is not retried immediately after a restart.
- Bulk real-source enable also preserves active cooldowns instead of clearing rate-limit pauses.
- Project packaging now excludes Playwright `test-results` and `playwright-report` directories in addition to secrets/runtime/build caches.
- Telegram lead messages are now rich cards with source, title, price, year/mileage, geo, publish/detect time, matched filters and VIN/plate state.
- Dashboard now shows live latency metrics from protected `/metrics`.
- Added `LIVE` monitoring mode: core pulse 10s, OLX 10s, Cars.ua 12s, RST 20s, AUTO.RIA 60s to protect API quota.
- Added `LAST_HOUR` freshness mode and switched the current active filter to it for "just posted" monitoring.
- Added AUTO.RIA geography mapping for official `state[i]`/`city[i]` search parameters; cities without known AUTO.RIA ids fall back to local city post-filter after API region filtering.
- Changed AUTO.RIA `published_after` / `created_after` to ISO timestamps and kept newest-first official search.
- Added Social Inbox API/dashboard tab for accepted Telegram listings, parser score, matched filters, notification status and vehicle-check status.
- Added fast local VIN/plate extraction from listing text when fake vehicle checks are disabled.
- Excluded event-driven `TELEGRAM` from scheduled collector ticks and auto-disabled `MOCK` when `MOCK_SOURCE_ENABLED=false`.
- Added unit tests for AUTO.RIA geo URL generation and VIN/plate extraction.
- Added unit tests for anti-bot detection.

### Source Contexts / AUTO.RIA / Worker Safety

- Added `source_search_states` for per-filter/per-query source state.
- Added Search Planner dashboard page and `/search-plan` API with AUTO.RIA quota, context state and filter risk diagnostics.
- Collector runs now build filter-scoped search contexts instead of one broad source scan.
- Reworked AUTO.RIA collector to use official search ids first, then info only for new candidates.
- Added AUTO.RIA request quota guard with daily/hourly limits, soft reserve and paid-method flags.
- Added `LIMITED` source/run status; RST now reports limited timestamp confidence instead of pretending listings are fresh.
- Disabled fake vehicle check data by default through `FAKE_VEHICLE_CHECK_ENABLED=false`.
- Hardened Telegram notification reservation with a conditional DB lease update.
- Added unit tests for AUTO.RIA search URL generation and source search fingerprint stability.
- Guarded mutating dashboard E2E controls behind `E2E_ALLOW_USER_DB=true`.

### BFF / STOP / Runtime Hardening

- Moved Dashboard writes to same-origin `/api/backend/*`; browser no longer receives `LOCAL_API_TOKEN`.
- Added server-side Dashboard proxy config via `INTERNAL_API_URL` + `LOCAL_API_TOKEN`.
- Fixed empty POST body handling for `STOP` and other dashboard commands.
- Added `MonitoringState.generation` and stale scheduled job protection in worker.
- Added `SKIPPED` and `CANCELLED_BY_USER` collector run statuses for stopped/stale work.
- Added manual collector dedup via `MANUAL_CHECK_DEDUP_SECONDS`.
- Added Telegram notification lease fields and `PROCESSING` / `RETRY_PENDING` states.
- Disabled AUTO.RIA taxonomy network calls when no API key is configured; local fallback is explicit.
- Added Playwright E2E smoke tests for Dashboard render, token non-leak and BFF STOP/START.

- Fixed OLX freshness model: `publishedAt` now uses only `createdTime`; `lastRefreshTime` is stored as `refreshedAt`.
- Added `timestampConfidence`, `skipReason`, `refreshedAt`, duplicate metadata and seller identifiers to listing persistence.
- Disabled `MOCK` source by default via `MOCK_SOURCE_ENABLED=false`.
- Added `DEVELOPMENT DATA` badge for mock listings.
- Split Windows and Docker env examples to avoid PostgreSQL port conflicts.
- Added `pnpm doctor`, `pnpm package:project`, `pnpm db:migrate:deploy`, `pnpm autostart:install`, `pnpm autostart:remove`.
- Restricted API host to `127.0.0.1` by default and locked CORS to `DASHBOARD_ORIGIN`.
- Added `LOCAL_API_TOKEN` protection for local mutating endpoints and logs/metrics.
- Made `SOCIAL_READER_TOKEN` mandatory for Telegram reader ingest.
- Reworked scheduler to per-source `nextCheckAt` with jitter and safe per-run BullMQ job IDs.
- Added Redis collector locks to prevent overlapping scans per source.
- Reworked Duplicate Guard: strong duplicate only for external ID, canonical URL, VIN, plate or seller phone; title+price+year is possible duplicate only.
- Made Telegram send idempotent with one `TelegramNotification` per listing.
- Added Prisma migration baseline: `20260710_hardening_baseline`.
- Added Ukraine region/city reference data with aliases and linked dashboard selectors.
- Updated Filter Engine to use normalized region/city IDs and aliases.
- Fixed Telegram date handling so `messageDate` is never replaced with `firstSeenAt`.
- Improved Telegram parser for city, region, phone, VIN, plate, fuel and transmission.
- Added `telegram.media.fetch` queue scaffold after successful Telegram send.
- Added `/health`, `/system/check` and protected `/metrics`.
- Added Vitest and unit tests for freshness, OLX date normalization, Telegram parser, MOCK default, duplicate guard, price normalization and region/city filters.
- Updated Windows start/stop/status scripts with migration deploy, PID tracking and autostart visibility.
- Updated `.gitignore` and ZIP packaging exclusions for secrets/runtime/session files.

Known limitations:

- Active AUTO.RIA filters still need official `mark_id` / `model_id` to avoid broad API searches and quota waste.
- Telegram reader has to be run/connected separately for real channel events; the bot/send path is configured.
- Telegram media downloader, OCR/ALPR, real VIN provider and daily cached NBU rate provider are not fully implemented yet.
- Current local dashboard auth uses a localhost bearer token; future external/mobile access needs a separate auth layer.

### Stage 25: OLX Fast Feeds / Fresh Listing Speed

- Added parallel OLX newest-first feed scanning with configurable `OLX_EXTRA_SEARCH_URLS`.
- Added default extra OLX private-seller feed so newly posted private car listings are checked alongside the main OLX cars feed.
- Forced every configured OLX feed to `search[order]=created_at:desc` before fetching.
- Added `OLX_MAX_NEW_PER_RUN` and `OLX_REQUEST_TIMEOUT_MS` for faster realtime tuning.
- Deduplicated OLX ads across feeds by external id and sorted normalized results by real publication time before notification flow.
- Kept compliant anti-bot behavior: CAPTCHA/Cloudflare/429 responses pause the source instead of attempting bypass or auto-solving.
- Classified HTML source abort/timeout responses as short `LIMITED` cooldowns instead of failed collector errors.
- Added unit coverage for OLX feed URL normalization, newest-first enforcement and feed deduplication.
