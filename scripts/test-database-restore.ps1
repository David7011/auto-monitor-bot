[CmdletBinding()]
param(
  [string]$ArchivePath
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$BackupRoot = Join-Path $ProjectRoot ".runtime\backups"
$DrillRoot = Join-Path $ProjectRoot ".runtime\restore-drills"
$SevenZip = "C:\Program Files\7-Zip\7z.exe"

function Get-DotEnvValue([string]$Key) {
  $line = Get-Content -LiteralPath (Join-Path $ProjectRoot ".env") -Encoding UTF8 |
    Where-Object { $_ -match "^\s*$([regex]::Escape($Key))\s*=" } |
    Select-Object -Last 1
  if (!$line) { return "" }
  $value = ($line -split "=", 2)[1].Trim()
  if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'")))) {
    return $value.Substring(1, $value.Length - 2)
  }
  return ($value -replace "\s+#.*$", "").Trim()
}

function Resolve-PostgresTool([string]$Name) {
  $candidates = @(
    "D:\PostgreSQL\bin\$Name.exe",
    "C:\Program Files\PostgreSQL\17\bin\$Name.exe",
    "C:\Program Files\PostgreSQL\16\bin\$Name.exe",
    (Get-Command "$Name.exe" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
  )
  return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

New-Item -ItemType Directory -Force -Path $DrillRoot | Out-Null
if (!$ArchivePath) {
  $ArchivePath = Get-ChildItem -LiteralPath $BackupRoot -Filter "database-*.7z" -File |
    Sort-Object LastWriteTime -Descending | Select-Object -ExpandProperty FullName -First 1
}
if (!$ArchivePath -or !(Test-Path -LiteralPath $ArchivePath)) { throw "No encrypted database backup is available" }
$ArchivePath = [System.IO.Path]::GetFullPath($ArchivePath)
if (!(Test-Path -LiteralPath $SevenZip)) { throw "7-Zip is required: $SevenZip" }

$hashPath = "$ArchivePath.sha256"
if (!(Test-Path -LiteralPath $hashPath)) { throw "Backup checksum is missing: $hashPath" }
$expectedHash = ((Get-Content -LiteralPath $hashPath -Raw) -split "\s+", 2)[0].Trim().ToLowerInvariant()
$actualHash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expectedHash -ne $actualHash) { throw "Backup checksum mismatch" }

$databaseUrl = Get-DotEnvValue "DATABASE_URL"
$encryptionPassword = Get-DotEnvValue "BACKUP_ENCRYPTION_PASSWORD"
if (!$databaseUrl -or $encryptionPassword.Length -lt 32) { throw "Database or backup credentials are not configured" }
$uri = [Uri]$databaseUrl
$userInfo = [Uri]::UnescapeDataString($uri.UserInfo).Split(':', 2)
$databaseUser = $userInfo[0]
$databasePassword = if ($userInfo.Count -gt 1) { $userInfo[1] } else { "" }
$databasePort = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
$databaseName = "amb_restore_drill_$(Get-Date -Format 'yyyyMMddHHmmss')_$([Guid]::NewGuid().ToString('N').Substring(0, 6))"
$workDir = Join-Path $DrillRoot $databaseName
$pgRestore = Resolve-PostgresTool "pg_restore"
$createdb = Resolve-PostgresTool "createdb"
$dropdb = Resolve-PostgresTool "dropdb"
$psql = Resolve-PostgresTool "psql"
if (!$pgRestore -or !$createdb -or !$dropdb -or !$psql) { throw "PostgreSQL restore tools are missing" }

$previousPassword = $env:PGPASSWORD
$created = $false
$startedAt = Get-Date
try {
  New-Item -ItemType Directory -Force -Path $workDir | Out-Null
  & $SevenZip x -y "-p$encryptionPassword" "-o$workDir" $ArchivePath *> $null
  if ($LASTEXITCODE -ne 0) { throw "Encrypted archive extraction failed" }
  $dumpPath = Get-ChildItem -LiteralPath $workDir -Filter "*.dump" -File -Recurse | Select-Object -ExpandProperty FullName -First 1
  if (!$dumpPath) { throw "The backup archive does not contain a PostgreSQL dump" }
  & $pgRestore --list $dumpPath *> $null
  if ($LASTEXITCODE -ne 0) { throw "pg_restore could not read the extracted dump" }

  $env:PGPASSWORD = $databasePassword
  & $createdb "--host=$($uri.Host)" "--port=$databasePort" "--username=$databaseUser" "--encoding=UTF8" $databaseName
  if ($LASTEXITCODE -ne 0) { throw "Could not create the temporary restore database" }
  $created = $true
  & $pgRestore "--host=$($uri.Host)" "--port=$databasePort" "--username=$databaseUser" `
    "--dbname=$databaseName" "--no-owner" "--no-privileges" "--exit-on-error" $dumpPath
  if ($LASTEXITCODE -ne 0) { throw "Restoring the temporary database failed" }

  $validation = & $psql "--host=$($uri.Host)" "--port=$databasePort" "--username=$databaseUser" `
    "--dbname=$databaseName" --tuples-only --no-align --command `
    "SELECT (to_regclass('public.filters') IS NOT NULL AND to_regclass('public.listings') IS NOT NULL AND to_regclass('public.source_seen_listings') IS NOT NULL)::text || '|' || (SELECT count(*) FROM filters)::text || '|' || (SELECT count(*) FROM listings)::text;"
  if ($LASTEXITCODE -ne 0 -or !$validation -or !$validation.Trim().StartsWith("true|")) {
    throw "Restored database structural validation failed: $validation"
  }
  $parts = $validation.Trim().Split('|')
  @{
    testedAt = (Get-Date).ToString("o")
    archive = [IO.Path]::GetFileName($ArchivePath)
    sha256 = $actualHash
    filters = [int]$parts[1]
    listings = [int]$parts[2]
    durationSeconds = [Math]::Round(((Get-Date) - $startedAt).TotalSeconds, 2)
    result = "PASS"
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $DrillRoot "latest.json") -Encoding UTF8
  Write-Host "Restore drill passed: $($parts[1]) filters and $($parts[2]) listings restored into an isolated temporary database."
} finally {
  if ($created) {
    & $dropdb "--host=$($uri.Host)" "--port=$databasePort" "--username=$databaseUser" --force $databaseName *> $null
  }
  $env:PGPASSWORD = $previousPassword
  if (Test-Path -LiteralPath $workDir) {
    $resolved = [System.IO.Path]::GetFullPath($workDir)
    $prefix = $DrillRoot.TrimEnd('\') + '\'
    if (!$resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove a path outside the restore-drill directory: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
