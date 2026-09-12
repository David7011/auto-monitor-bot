[CmdletBinding()]
param(
  [int]$RetentionDays = 14,
  [int]$MinimumAgeHours = 20,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$BackupRoot = Join-Path $ProjectRoot ".runtime\backups"
$LockPath = Join-Path $ProjectRoot ".runtime\database-backup.lock"
. (Join-Path $PSScriptRoot "invoke-backup-crypto.ps1")
. (Join-Path $PSScriptRoot "backup-health.ps1")

function Get-DotEnvValue([string]$Key) {
  $envPath = Join-Path $ProjectRoot ".env"
  if (!(Test-Path -LiteralPath $envPath)) { return "" }
  $line = Get-Content -LiteralPath $envPath -Encoding UTF8 |
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
    (Join-Path $ProjectRoot ".runtime\postgresql\bin\$Name.exe"),
    "D:\PostgreSQL\bin\$Name.exe",
    "C:\Program Files\PostgreSQL\17\bin\$Name.exe",
    "C:\Program Files\PostgreSQL\16\bin\$Name.exe",
    (Get-Command "$Name.exe" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
  )
  return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Get-Sha256Hex([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Remove-BackupItem([string]$Path) {
  $resolved = [System.IO.Path]::GetFullPath($Path)
  $prefix = $BackupRoot.TrimEnd('\') + '\'
  if (!$resolved.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a path outside the backup directory: $resolved"
  }
  Remove-Item -LiteralPath $resolved -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
$lock = $null
try {
  $lock = [IO.File]::Open($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch {
  Write-Host "A database backup is already running; this request was coalesced."
  exit 0
}

try {
  $latest = Get-ChildItem -LiteralPath $BackupRoot -Filter "database-*.ambbak" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (!$Force -and $latest -and $latest.LastWriteTime -gt (Get-Date).AddHours(-$MinimumAgeHours)) {
    Write-Host "Recent encrypted backup already exists: $($latest.FullName)"
    exit 0
  }

  $databaseUrl = Get-DotEnvValue "DATABASE_URL"
  $password = Get-DotEnvValue "BACKUP_ENCRYPTION_PASSWORD"
  $mirrorRoot = Get-DotEnvValue "BACKUP_MIRROR_PATH"
  if (!$databaseUrl) { throw "DATABASE_URL is missing" }
  if ($password.Length -lt 32) { throw "BACKUP_ENCRYPTION_PASSWORD must contain at least 32 characters" }

  $uri = [Uri]$databaseUrl
  if ($uri.Scheme -notin @("postgresql", "postgres")) { throw "Only PostgreSQL DATABASE_URL is supported" }
  $userInfo = [Uri]::UnescapeDataString($uri.UserInfo).Split(':', 2)
  $databaseUser = $userInfo[0]
  $databasePassword = if ($userInfo.Count -gt 1) { $userInfo[1] } else { "" }
  $databaseName = [Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart('/'))
  $databasePort = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
  $pgDump = Resolve-PostgresTool "pg_dump"
  $pgRestore = Resolve-PostgresTool "pg_restore"
  if (!$pgDump -or !$pgRestore) { throw "pg_dump.exe and pg_restore.exe are required" }

  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $dumpPath = Join-Path $BackupRoot "database-$stamp.dump"
  $archivePath = Join-Path $BackupRoot "database-$stamp.ambbak"
  $partialArchive = "$archivePath.partial"
  $hashPath = "$archivePath.sha256"
  $metadataPath = "$archivePath.json"
  $previousPassword = $env:PGPASSWORD
  try {
    $env:PGPASSWORD = $databasePassword
    & $pgDump "--host=$($uri.Host)" "--port=$databasePort" "--username=$databaseUser" `
      "--format=custom" "--compress=6" "--no-owner" "--no-privileges" "--file=$dumpPath" $databaseName
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $dumpPath) -or (Get-Item $dumpPath).Length -lt 1024) {
      throw "pg_dump did not create a valid non-empty custom dump"
    }

    & $pgRestore "--list" $dumpPath *> $null
    if ($LASTEXITCODE -ne 0) { throw "pg_restore could not read the new dump" }

    Invoke-BackupCrypto -Operation encrypt -InputPath $dumpPath -OutputPath $partialArchive -Password $password
    if (!(Test-Path -LiteralPath $partialArchive)) { throw "Backup encryption did not create an archive" }
    Move-Item -LiteralPath $partialArchive -Destination $archivePath -Force

    $hash = Get-Sha256Hex $archivePath
    "$hash  $([IO.Path]::GetFileName($archivePath))" | Set-Content -LiteralPath $hashPath -Encoding ASCII
    @{
      createdAt = (Get-Date).ToString("o")
      database = $databaseName
      archive = [IO.Path]::GetFileName($archivePath)
      bytes = (Get-Item $archivePath).Length
      sha256 = $hash
      encryption = "AES-256-GCM; scrypt N=131072,r=8,p=1; authenticated AMBBK001 header"
      validation = "pg_restore --list passed; authenticated restore drill required"
    } | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding UTF8

    if ($mirrorRoot) {
      $mirrorFullPath = [System.IO.Path]::GetFullPath($mirrorRoot)
      if (!(Test-AmbBackupIndependent $BackupRoot $mirrorFullPath)) {
        throw "BACKUP_MIRROR_PATH must be on a physically independent disk or remote UNC destination"
      }
      New-Item -ItemType Directory -Force -Path $mirrorFullPath | Out-Null
      # Preserve staging/verification/publish-archive-last semantics in the
      # shared helper used by the isolated regression acceptance.
      Publish-AmbBackupMirror $mirrorFullPath @($archivePath, $hashPath, $metadataPath) $hash
      $mirrorCutoff = (Get-Date).AddDays(-[Math]::Max(1, $RetentionDays))
      Remove-AmbExpiredBackupSets $mirrorFullPath $mirrorCutoff
      Write-Host "Verified encrypted backup mirror created on independent storage."
    }
  } finally {
    $env:PGPASSWORD = $previousPassword
    $password = $null
    Remove-BackupItem $dumpPath
    Remove-BackupItem $partialArchive
  }

  $cutoff = (Get-Date).AddDays(-[Math]::Max(1, $RetentionDays))
  Remove-AmbExpiredBackupSets $BackupRoot $cutoff

  Write-Host "Authenticated encrypted PostgreSQL backup created: $archivePath"
} finally {
  if ($lock) { $lock.Dispose() }
}
