param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RuntimeRoot = Join-Path $ProjectRoot ".runtime"
$DownloadDir = Join-Path $RuntimeRoot "downloads"
$TargetDir = Join-Path $RuntimeRoot "redis-modern"
$Version = "8.8.0"
$ArchiveName = "Redis-$Version-Windows-x64-msys2.zip"
$ArchivePath = Join-Path $DownloadDir $ArchiveName
$DownloadUrl = "https://github.com/redis-windows/redis-windows/releases/download/$Version/$ArchiveName"
$ExpectedSha256 = "8af6fd6c4aac3e13ded36f249da8114b3be32df60ab589da7c3513aa8b1a86cd"

function Find-CompatibleRedis {
  if (!(Test-Path -LiteralPath $TargetDir)) { return $null }
  $candidate = Get-ChildItem -LiteralPath $TargetDir -Recurse -Filter "redis-server.exe" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (!$candidate) { return $null }

  $versionOutput = & $candidate.FullName --version 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch "v=(\d+)\.(\d+)") { return $null }
  $major = [int]$Matches[1]
  $minor = [int]$Matches[2]
  if ($major -lt 6 -or ($major -eq 6 -and $minor -lt 2)) { return $null }
  return $candidate.FullName
}

$existing = Find-CompatibleRedis
if ($existing -and !$Force) {
  Write-Host "Compatible project Redis already installed: $existing"
  exit 0
}

$resolvedRuntime = (Resolve-Path $RuntimeRoot).Path
if (!$resolvedRuntime.StartsWith($ProjectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe runtime path: $resolvedRuntime"
}

New-Item -ItemType Directory -Force -Path $DownloadDir | Out-Null
if (!(Test-Path -LiteralPath $ArchivePath)) {
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    & $curl.Source -L --fail --retry 3 --connect-timeout 15 --max-time 180 -o $ArchivePath $DownloadUrl
    if ($LASTEXITCODE -ne 0) { throw "Redis download failed with exit code $LASTEXITCODE" }
  } else {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $ArchivePath
  }
}

$actualSha256 = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -ne $ExpectedSha256) {
  throw "Redis archive checksum mismatch: $actualSha256"
}

if (Test-Path -LiteralPath $TargetDir) {
  $resolvedTarget = (Resolve-Path $TargetDir).Path
  if (!$resolvedTarget.StartsWith($resolvedRuntime, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe Redis target path: $resolvedTarget"
  }
  Remove-Item -LiteralPath $TargetDir -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
$tar = Get-Command tar.exe -ErrorAction SilentlyContinue
if ($tar) {
  & $tar.Source -xf $ArchivePath -C $TargetDir
  if ($LASTEXITCODE -ne 0) { throw "Redis extraction failed with exit code $LASTEXITCODE" }
} else {
  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $TargetDir
}

$installed = Find-CompatibleRedis
if (!$installed) { throw "Redis $Version was extracted but redis-server.exe is not usable" }
Write-Host "Redis $Version installed in $TargetDir"
