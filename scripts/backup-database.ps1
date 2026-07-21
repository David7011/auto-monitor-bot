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
$SevenZip = "C:\Program Files\7-Zip\7z.exe"

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
    "D:\PostgreSQL\bin\$Name.exe",
    "C:\Program Files\PostgreSQL\17\bin\$Name.exe",
    "C:\Program Files\PostgreSQL\16\bin\$Name.exe",
    (Get-Command "$Name.exe" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
  )
  return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
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
  $latest = Get-ChildItem -LiteralPath $BackupRoot -Filter "database-*.7z" -File -ErrorAction SilentlyContinue |
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
  if (!(Test-Path -LiteralPath $SevenZip)) { throw "7-Zip is required for encrypted backups: $SevenZip" }

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
  $archivePath = Join-Path $BackupRoot "database-$stamp.7z"
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

    & $SevenZip a -t7z -mx=7 -mhe=on "-p$password" $partialArchive $dumpPath *> $null
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $partialArchive)) { throw "7-Zip encryption failed" }
    & $SevenZip t "-p$password" $partialArchive *> $null
    if ($LASTEXITCODE -ne 0) { throw "Encrypted archive validation failed" }
    Move-Item -LiteralPath $partialArchive -Destination $archivePath -Force

    $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $([IO.Path]::GetFileName($archivePath))" | Set-Content -LiteralPath $hashPath -Encoding ASCII
    @{
      createdAt = (Get-Date).ToString("o")
      database = $databaseName
      archive = [IO.Path]::GetFileName($archivePath)
      bytes = (Get-Item $archivePath).Length
      sha256 = $hash
      encryption = "7z AES-256 with encrypted headers"
      validation = "pg_restore --list and 7z test passed"
    } | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding UTF8

    if ($mirrorRoot) {
      $mirrorFullPath = [System.IO.Path]::GetFullPath($mirrorRoot)
      $backupVolume = [System.IO.Path]::GetPathRoot($BackupRoot)
      $mirrorVolume = [System.IO.Path]::GetPathRoot($mirrorFullPath)
      if ($backupVolume -and $mirrorVolume -and $backupVolume.Equals($mirrorVolume, [StringComparison]::OrdinalIgnoreCase)) {
        throw "BACKUP_MIRROR_PATH must be on a different volume or UNC destination"
      }
      New-Item -ItemType Directory -Force -Path $mirrorFullPath | Out-Null
      foreach ($item in @($archivePath, $hashPath, $metadataPath)) {
        Copy-Item -LiteralPath $item -Destination (Join-Path $mirrorFullPath ([IO.Path]::GetFileName($item))) -Force
      }
      $mirrorCutoff = (Get-Date).AddDays(-[Math]::Max(1, $RetentionDays))
      Get-ChildItem -LiteralPath $mirrorFullPath -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^database-\d{8}-\d{6}\.7z(?:\.sha256|\.json)?$' -and $_.LastWriteTime -lt $mirrorCutoff } |
        ForEach-Object {
          $resolvedMirrorItem = [System.IO.Path]::GetFullPath($_.FullName)
          $mirrorPrefix = $mirrorFullPath.TrimEnd('\') + '\'
          if (!$resolvedMirrorItem.StartsWith($mirrorPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove a path outside the mirror directory: $resolvedMirrorItem"
          }
          Remove-Item -LiteralPath $resolvedMirrorItem -Force
        }
    }
  } finally {
    $env:PGPASSWORD = $previousPassword
    Remove-BackupItem $dumpPath
    Remove-BackupItem $partialArchive
  }

  $cutoff = (Get-Date).AddDays(-[Math]::Max(1, $RetentionDays))
  Get-ChildItem -LiteralPath $BackupRoot -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^database-\d{8}-\d{6}\.7z(?:\.sha256|\.json)?$' -and $_.LastWriteTime -lt $cutoff } |
    ForEach-Object { Remove-BackupItem $_.FullName }

  Write-Host "Encrypted PostgreSQL backup created and validated: $archivePath"
} finally {
  if ($lock) { $lock.Dispose() }
}
