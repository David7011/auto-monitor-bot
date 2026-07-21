# Восстановление зашифрованного бэкапа PostgreSQL

Проект больше не создаёт приватные ZIP. База хранится только в `.runtime\backups\database-*.7z`, зашифрованном AES-256 с зашифрованными именами файлов.

Перед восстановлением нужны:

- соответствующий `.7z` и его `.sha256`/`.json`;
- `BACKUP_ENCRYPTION_PASSWORD` из сохранённого локального `.env`;
- 7-Zip и `pg_restore.exe`;
- остановленный worker/API, чтобы база не менялась во время восстановления.

## 1. Проверить целостность архива

```powershell
$archive = 'D:\auto-monitor-bot\.runtime\backups\database-YYYYMMDD-HHMMSS.7z'
$expected = (Get-Content "$archive.sha256" -Raw).Split(' ')[0].Trim()
$actual = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'SHA-256 backup mismatch' }
```

## 2. Извлечь dump во временный каталог

Не печатайте пароль в консоль и не сохраняйте его в отдельный текстовый файл.

```powershell
$line = Get-Content D:\auto-monitor-bot\.env -Encoding UTF8 |
  Where-Object { $_ -match '^BACKUP_ENCRYPTION_PASSWORD=' } |
  Select-Object -Last 1
$password = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
$restoreDir = 'D:\auto-monitor-bot\.runtime\restore-staging'
[IO.Directory]::CreateDirectory($restoreDir) | Out-Null
& 'C:\Program Files\7-Zip\7z.exe' t "-p$password" $archive
if ($LASTEXITCODE -ne 0) { throw 'Encrypted backup validation failed' }
& 'C:\Program Files\7-Zip\7z.exe' x -y "-p$password" "-o$restoreDir" $archive
if ($LASTEXITCODE -ne 0) { throw 'Backup extraction failed' }
```

## 3. Восстановить PostgreSQL

Сначала остановите проект и убедитесь, что выбрана правильная локальная база.

```powershell
cd D:\auto-monitor-bot
.\amb.cmd local:stop
$dump = Get-ChildItem $restoreDir -Filter 'database-*.dump' | Select-Object -First 1
& 'D:\PostgreSQL\bin\pg_restore.exe' `
  --clean --if-exists --no-owner --no-privileges `
  --dbname='postgresql://USER:PASSWORD@127.0.0.1:55432/auto_monitor' `
  $dump.FullName
if ($LASTEXITCODE -ne 0) { throw 'pg_restore failed' }
.\amb.cmd db:migrate:deploy
.\amb.cmd local:start
```

Замените `USER:PASSWORD` значениями своей локальной БД. Не публикуйте эту команду с реальным паролем.

## 4. Проверить и убрать открытый dump

```powershell
.\amb.cmd local:status
if ([IO.Directory]::Exists($restoreDir)) { [IO.Directory]::Delete($restoreDir, $true) }
```

После восстановления проверьте `/health`, очереди, активные фильтры и свежий OLX-проход. Если `.env` или пароль архива когда-либо раскрывались, замените Telegram/API/dashboard/backup credentials.
