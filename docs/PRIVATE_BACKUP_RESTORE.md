# Восстановление зашифрованного бэкапа PostgreSQL

Новые резервные копии базы хранятся в `.runtime\backups\database-*.ambbak`. Это потоковый контейнер проекта с AES-256-GCM, уникальными salt/nonce, ключом из scrypt и аутентифицированным заголовком. Старые `.7z` не удаляются, но автоматическая проверка восстановления использует только новый формат.

## Независимое зеркало

Задайте `BACKUP_MIRROR_PATH` в локальном `.env` как каталог на другом физическом
носителе или UNC/off-device storage. Путь на томе `C:` намеренно отклоняется.
Секрет шифрования нельзя хранить рядом с архивами; сохраните его отдельно в
менеджере паролей или другом защищённом канале.

Backup сначала создаётся и проверяется локально, затем копируется во временный
каталог зеркала, повторно проверяется SHA-256 и публикуется атомарно: checksum и
metadata появляются до самого `.ambbak`. Если зеркало недоступно или копия
повреждена, scheduled task завершается ошибкой, а уже созданный локальный архив
сохраняется.

Еженедельный restore drill при настроенном зеркале выбирает архив именно оттуда и
не переключается молча на локальную копию. Для осознанной ручной проверки только
локального архива доступен параметр `-LocalOnly` у
`scripts\test-database-restore.ps1`.

Перед восстановлением нужны:

- соответствующий `.ambbak` и его `.sha256`/`.json`;
- `BACKUP_ENCRYPTION_PASSWORD` из сохранённого локального `.env`;
- закреплённый Node.js runtime проекта и `pg_restore.exe`;
- остановленный worker/API, чтобы база не менялась во время восстановления.

## 1. Проверить целостность архива

```powershell
$archive = 'D:\auto-monitor-bot\.runtime\backups\database-YYYYMMDD-HHMMSS.ambbak'
$expected = (Get-Content "$archive.sha256" -Raw).Split(' ')[0].Trim()
$actual = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'SHA-256 backup mismatch' }
```

## 2. Извлечь dump во временный каталог

Не печатайте пароль в консоль, не сохраняйте его в отдельный текстовый файл и не передавайте аргументом процесса: аргументы доступны локальной диагностике. Проектный helper передаёт пароль закреплённому Node.js через закрытый standard input.

```powershell
$line = Get-Content D:\auto-monitor-bot\.env -Encoding UTF8 |
  Where-Object { $_ -match '^BACKUP_ENCRYPTION_PASSWORD=' } |
  Select-Object -Last 1
$password = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
$restoreDir = 'D:\auto-monitor-bot\.runtime\restore-staging'
[IO.Directory]::CreateDirectory($restoreDir) | Out-Null
. D:\auto-monitor-bot\scripts\invoke-backup-crypto.ps1
$dumpPath = Join-Path $restoreDir 'database.dump'
Invoke-BackupCrypto `
  -Operation decrypt -InputPath $archive -OutputPath $dumpPath `
  -Password $password
$password = $null
```

## 3. Восстановить PostgreSQL

Сначала остановите проект и убедитесь, что выбрана правильная локальная база.

```powershell
cd D:\auto-monitor-bot
.\amb.cmd local:stop
$dump = Get-ChildItem $restoreDir -Filter 'database-*.dump' | Select-Object -First 1
$env:PGPASSWORD = '<LOCAL_DATABASE_PASSWORD>'
& 'D:\PostgreSQL\bin\pg_restore.exe' `
  --clean --if-exists --no-owner --no-privileges `
  --host=127.0.0.1 --port=55432 --username='<LOCAL_DATABASE_USER>' `
  --dbname=auto_monitor `
  $dump.FullName
if ($LASTEXITCODE -ne 0) { throw 'pg_restore failed' }
$env:PGPASSWORD = $null
.\amb.cmd db:migrate:deploy
.\amb.cmd local:start
```

Введите локальные учётные данные только в текущей защищённой сессии PowerShell. Не сохраняйте их в документацию или историю команд. Для регулярной проверки восстановления используйте `.\amb.cmd db:restore:test`: она создаёт изолированную временную базу и удаляет её после проверки.

## 4. Проверить и убрать открытый dump

```powershell
.\amb.cmd local:status
if ([IO.Directory]::Exists($restoreDir)) { [IO.Directory]::Delete($restoreDir, $true) }
```

После восстановления проверьте `/health`, очереди, активные фильтры и свежий OLX-проход. Если `.env` или пароль архива когда-либо раскрывались, замените Telegram/API/dashboard/backup credentials.
