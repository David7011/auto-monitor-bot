# Auto Monitor Bot

Локальная система непрерывного мониторинга автомобильных объявлений с приоритетом OLX. Проект собирает объявления, сохраняет исходные наблюдения до фильтрации, устраняет дубли, применяет пользовательские фильтры и как можно раньше отправляет первое сообщение в Telegram. Более тяжёлые проверки рынка, VIN и номера выполняются после первой отправки и обновляют уже созданное сообщение.

Проект работает только на этом ноутбуке. Публичный сервер не требуется: при загрузке Windows система стартует от `SYSTEM`, работает до выключения компьютера и восстанавливается watchdog при реальном падении локального процесса.

## Состав

- `apps/api` — Fastify API, планировщик, управление мониторингом, health и метрики.
- `apps/worker` — BullMQ workers, сборщики, нормализация, фильтры, Telegram и enrichment.
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

## Автозапуск Windows

```powershell
.\amb.cmd autostart:install
```

Создаются три задачи Планировщика Windows:

- `Auto Monitor Bot` — один запуск при загрузке Windows, до входа пользователя; повторного запуска при логине нет.
- `Auto Monitor Bot Watchdog` — каждую минуту проверяет PID, порты и локальную инфраструктуру. Недоступность отдельного внешнего сайта показывается как `WARN` и не создаёт restart-loop.
- `Auto Monitor Bot Database Backup` — ежедневный проверяемый бэкап PostgreSQL в 03:15.

Все задачи работают от `SYSTEM` с наивысшими правами. Установщик откажется регистрировать их, если каталог проекта доступен для записи обычным сторонним пользователям.

Удаление задач:

```powershell
.\amb.cmd autostart:remove
```

## Как обеспечивается скорость OLX

- LIVE-интервал OLX по умолчанию — 4 секунды с небольшим jitter.
- Публичная newest-first выдача запрашивается страницами по 50 объявлений.
- Realtime-проход адаптивно листает до `OLX_REALTIME_MAX_PAGES`; одиночное старое или продвигаемое объявление больше не останавливает скан.
- Граница overlap считается достоверной только для полностью известной выдачи либо непрерывного известного хвоста.
- Если лимит кандидатов исчерпан, проход не объявляется завершённым ошибочно.
- Независимый backfill каждые 5 минут проходит до 20 страниц и восстанавливает возможные пропуски.
- `lastCompletedCutoff` обновляется только после доказанного достижения временной границы.
- Все нормализованные кандидаты сначала сохраняются в журнал наблюдений, а незавершённые записи повторно обрабатываются очередью recovery.
- Первое Telegram-сообщение сохраняется и отправляется до фонового enrichment.

Это максимально быстрый безопасный режим для публичного интерфейса OLX, но абсолютную гарантию «ни одного пропуска» внешний сайт без официального стабильного event API дать не может. CAPTCHA, rate limit, изменение формата выдачи, сетевой сбой и предел публичной пагинации являются внешними ограничениями. Система явно показывает такие случаи, использует `Retry-After`, экспоненциальную паузу и глубокий повторный проход вместо агрессивных запросов, повышающих риск блокировки.

Основные параметры:

```env
LIVE_OLX_INTERVAL_SECONDS=4
LIVE_OLX_JITTER_SECONDS=1
OLX_API_PAGE_SIZE=50
OLX_REALTIME_MAX_PAGES=5
OLX_BACKFILL_MAX_PAGES=20
BACKFILL_INTERVAL_SECONDS=300
BACKFILL_MAX_CANDIDATES=300
RATE_LIMIT_PAUSE_BASE_SECONDS=90
RATE_LIMIT_PAUSE_MAX_SECONDS=900
CAPTCHA_PAUSE_SECONDS=900
FAST_INLINE_TELEGRAM_SEND_ENABLED=true
FAST_INLINE_LISTING_PROCESSING_ENABLED=true
```

## Источники

- `OLX` — главный realtime-источник.
- `AUTO_RIA` — официальный API при наличии ключа и доступной квоты.
- `RST` — HTML-источник; может включать CAPTCHA.
- `CARS_UA` — публичная выдача.
- `AUTOMOTO` — резервный агрегатор с точностью времени до дня.
- `MOCK` — только для тестов, по умолчанию выключен.

Статус каждого целевого источника доступен в `GET /health -> sourceHealth`. В `GET /metrics -> latencyBySource` отдельно показаны задержки публикации, обнаружения и Telegram.

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

Создание ZIP с секретами запрещено. Обычный исходный архив без `.env`, `.runtime`, БД и ключей можно создать так:

```powershell
.\amb.cmd package:project
```

## Проверки

```powershell
.\amb.cmd check
.\amb.cmd audit:prod
.\amb.cmd android:check
.\amb.cmd test:e2e
```

`test:e2e` при необходимости создаёт случайного временного dashboard-пользователя и гарантированно удаляет его после запуска. Для сценария реального stop/start дополнительно задаётся `E2E_ALLOW_USER_DB=true` только в тестовом процессе.

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

Панель остаётся недоступной из публичного интернета. Текущий режим — приватный TCP внутри зашифрованного Tailscale-туннеля. Приложение принимает только loopback/LAN/Tailscale-адреса; публичный HTTP URL отклоняется.

## Ограничения, которые нельзя устранить только кодом

- Сайты могут менять HTML/API, вводить CAPTCHA или rate limit.
- На выключенном ноутбуке локальный проект не работает.
- Для app-layer HTTPS внутри tailnet требуется одноразово включить Tailscale HTTPS; текущий приватный TCP уже защищён самим туннелем.
- Крупные обновления Prisma/Next выполняются отдельной миграцией, а не автоматически в боевом апгрейде.

Актуальная проверенная оценка и оставшиеся риски находятся в [AUDIT.md](./AUDIT.md).
