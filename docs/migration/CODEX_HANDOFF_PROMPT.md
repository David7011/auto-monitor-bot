# Задача для Codex на новом HP ProBook 445 G9

Ты работаешь на НОВОМ ноутбуке HP ProBook 445 G9. На подключённой флешке находится каталог `AUTO_MONITOR_BOT_TRANSFER` с полным проверенным migration package проекта Auto Monitor Bot.

Твоя цель: безопасно восстановить проект на внутреннем SSD HP, установить только реально нужные зависимости, восстановить PostgreSQL и секреты, провести проверки в безопасном режиме и подготовить controlled cutover. Старый ноутбук должен оставаться рабочим и единственным production producer до отдельного подтверждённого переключения.

## Жёсткие ограничения

- Не удаляй и не изменяй данные старого ноутбука.
- Не форматируй флешку или диски.
- Не запускай production-мониторинг на HP, пока не доказано, что старая копия остановлена.
- Не выполняй `git reset --hard`, `git clean -fd`, `git restore .`, `FLUSHDB` или `FLUSHALL`.
- Не копируй `node_modules`, живой PostgreSQL `pgdata` или Redis AOF как источник миграции.
- Не публикуй `.env`, токены, пароли, cookies, API keys и keystore в Git или логах.
- Не обновляй major/minor версии runtime и зависимостей во время переноса.
- Не обходи CAPTCHA, rate limits, Defender, Firewall или другие механизмы защиты.
- Не импортируй XML scheduled tasks вслепую: они содержат старые пути.
- Не отмечай миграцию `VERIFIED`, пока на HP не пройдут build/tests/runtime/E2E.

## Порядок работы

### 1. Read-only audit HP и флешки

Определи сам, не спрашивая пользователя то, что можно проверить:

- модель, Windows build, x64, RAM, свободное место и timezone;
- букву флешки по label `KINGSTON` и наличие `AUTO_MONITOR_BOT_TRANSFER`;
- внутренний целевой диск и безопасный путь проекта;
- наличие Git, PowerShell, 7-Zip, Tailscale, Docker и WSL.

Не предполагай, что флешка будет иметь букву `E:`. Если на HP есть только `C:`, используй `C:\Projects\auto-monitor-bot`; если есть подходящий `D:`, можно сохранить `D:\auto-monitor-bot`. Все проектные скрипты должны работать относительно корня.

### 2. Проверка переноса

Скопируй весь `AUTO_MONITOR_BOT_TRANSFER` на внутренний SSD во временный каталог. Запусти `VERIFY_TRANSFER.ps1`. Требуй ноль несовпадений SHA-256. Проверь Authenticode установщиков Git и Tailscale из `tool-installers`; статус должен быть `Valid`. Официальный 7-Zip 26.03 не имеет Authenticode-подписи, поэтому для него требуй совпадение package SHA-256 и зафиксированный источник `https://github.com/ip7z/7zip/releases/download/26.03/7z2603-x64.exe`.

Если checksum или подпись не совпадает — остановись со статусом `BLOCKED`, ничего не устанавливай.

### 3. Минимальные инструменты

При отсутствии установи из локальных подписанных файлов:

- Git for Windows x64;
- 7-Zip x64;
- Tailscale x64 только для приватного удалённого доступа; предпочитай автономный `tailscale-setup-full-1.102.3.exe`.

Запуск нового установщика требует подтверждения пользователя в момент установки. Docker и WSL не устанавливай: текущий production их не использует.

### 4. Восстановление исходников

Создай целевой каталог через clone полного Git bundle, затем наложи авторитетный архив рабочего дерева:

```powershell
git clone '<TRANSFER>\project\git-history.bundle' '<PROJECT_ROOT>'
git -C '<PROJECT_ROOT>' remote set-url origin 'https://github.com/David7011/auto-monitor-bot.git'
& 'C:\Program Files\7-Zip\7z.exe' x -y "-o<PROJECT_ROOT>" '<TRANSFER>\project\working-tree-no-secrets-20260908.7z'
```

Проверь `git rev-parse HEAD`: ожидается `bfd0a1abbd8a118f7f88234273a2686327fed28b`. Сохрани dirty working tree: ожидаются 67 content-modified paths и 31 untracked path на момент создания пакета. Не нормализуй и не коммить файлы автоматически.

### 5. Секреты

Распакуй `secrets-encrypted\secrets-and-signing.7z` непосредственно в корень проекта через 7-Zip с интерактивно предоставленным пользователем `BACKUP_ENCRYPTION_PASSWORD`.

Проверяй только наличие:

- `.env`;
- опционального `apps\mobile-android\.signing.env`;
- `.runtime\android-signing\auto-monitor-release.jks`.

Не выводи содержимое или значения. Проверь, что Git игнорирует эти пути.

### 6. Закреплённые runtime

Сначала распакуй автономные архивы с флешки:

- `runtime-installers\node-pnpm-24.18.0-10.34.5.7z` в `<PROJECT_ROOT>\.runtime\node-runtime-v2`;
- `runtime-installers\redis-8.8.0-windows.7z` в `<PROJECT_ROOT>\.runtime\redis-modern`.

Затем выполни:

```powershell
Set-Location '<PROJECT_ROOT>'
powershell -NoProfile -ExecutionPolicy Bypass -File '.\scripts\prepare-new-pc.ps1' `
  -WithPostgres `
  -PostgresArchive '<TRANSFER>\runtime-installers\postgresql-18.6-1-windows-x64-binaries.zip' `
  -WithRedis `
  -WithDependencies
```

Команда должна подтвердить Node 24.18.0, pnpm 10.34.5, PostgreSQL 18.6 и Redis 8.8.0. Зависимости устанавливай только `amb.cmd install --frozen-lockfile`.

### 7. PostgreSQL dry restore

До production-запуска и без scheduled tasks:

- инициализируй новый локальный cluster в `<PROJECT_ROOT>\.runtime\pgdata` параметрами из `DATABASE_URL`, не печатая пароль;
- слушай только `127.0.0.1:55432`;
- проверь `.sha256` database archive;
- извлеки dump во временную локальную папку;
- проверь `pg_restore --list`;
- восстанови через `--no-owner --no-privileges --exit-on-error`;
- проверь таблицы, число миграций, filters/listings/observations;
- выполни `amb.cmd db:validate` и `amb.cmd db:migrate:deploy`.

Не перезаписывай неожиданно существующую базу. При обнаружении данных остановись и разберись read-only.

Предварительный архив служит для dry-run. Перед production cutover понадобится свежий финальный dump со старого ноутбука.

### 8. Проверки HP без двойного запуска

Не устанавливай autostart и не запускай live collectors. Выполни максимально возможные безопасные проверки:

```powershell
.\amb.cmd security:check
.\amb.cmd db:validate
.\amb.cmd check
.\amb.cmd check:full
.\amb.cmd acceptance:extended
```

Зафиксируй тесты, typecheck, lint, production build, Prisma, PostgreSQL/Redis fault-injection и Android gate отдельно. Не скрывай частичные или непрошедшие проверки.

### 9. Controlled cutover — только после явного подтверждения

Сначала подготовь отчёт `TRANSFERRED_NOT_VERIFIED` и запроси у пользователя разрешение на cutover. После разрешения:

1. На старом ноутбуке отключить четыре Auto Monitor Bot scheduled tasks.
2. Выполнить `scripts\stop.ps1 -All` и подтвердить остановку старых processes/ports.
3. Дождаться безопасного состояния очередей и создать свежий зашифрованный PostgreSQL backup со sidecar `.sha256`/`.json`.
4. Перенести и проверить новый backup на HP.
5. Восстановить финальную базу на HP.
6. Ещё раз подтвердить, что старая production-копия остановлена.
7. Один раз вручную запустить HP и проверить API, PostgreSQL, Redis, две hot replicas, background worker, очереди, OLX realtime, backfill/offline boundary и Telegram acceptance.
8. Проверить отсутствие duplicate jobs/alerts/inserts.
9. Только после успешного E2E установить задачи:

```powershell
.\amb.cmd security:harden
.\amb.cmd security:check
.\amb.cmd autostart:install
.\amb.cmd security:check
```

10. Выполнить свежий запуск SYSTEM task и `amb.cmd local:status`.

### 10. Финальный отчёт

Заполни `docs\migration\OLD_VS_NEW.md` фактическими значениями HP и обнови `MIGRATION_FINAL_REPORT.md`.

Допустимые статусы:

- `TRANSFERRED_NOT_VERIFIED` после установки без production E2E;
- `VERIFIED` только после настоящего controlled cutover и E2E;
- `BLOCKED` при проверяемом препятствии.

При любой проблеме сохрани старый ноутбук как rollback authority и следуй `docs\migration\ROLLBACK.md`.
