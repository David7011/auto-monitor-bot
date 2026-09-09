[CmdletBinding()]
param(
  [string]$ArchivePath,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$RuntimeRoot = Join-Path $ProjectRoot ".runtime"
$DownloadDir = Join-Path $RuntimeRoot "downloads"
$TargetDir = Join-Path $RuntimeRoot "postgresql"
$Version = "18.6"
$ArchiveName = "postgresql-18.6-1-windows-x64-binaries.zip"
$DownloadUrl = "https://get.enterprisedb.com/postgresql/$ArchiveName"
$ExpectedSha256 = "fbe23da234ee31547bf8a36d29dfd81e82b849df2d2b78d2eecb43d360252f8c"

function Assert-PathInside([string]$Path, [string]$Parent) {
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  if (!$full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe path outside $Parent`: $full"
  }
  return $full
}

function Test-InstalledRuntime {
  $postgres = Join-Path $TargetDir "bin\postgres.exe"
  if (!(Test-Path -LiteralPath $postgres)) { return $false }
  $output = (& $postgres --version 2>&1 | Out-String).Trim()
  return $LASTEXITCODE -eq 0 -and $output -match "PostgreSQL\) $([regex]::Escape($Version))(?:\s|$)"
}

if ((Test-InstalledRuntime) -and !$Force) {
  Write-Host "PostgreSQL $Version project runtime already installed: $TargetDir"
  exit 0
}

New-Item -ItemType Directory -Force -Path $RuntimeRoot, $DownloadDir | Out-Null
if (!$ArchivePath) { $ArchivePath = Join-Path $DownloadDir $ArchiveName }
$ArchivePath = [IO.Path]::GetFullPath($ArchivePath)

if (!(Test-Path -LiteralPath $ArchivePath)) {
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    & $curl.Source -L --fail --retry 3 --connect-timeout 15 --max-time 600 -o $ArchivePath $DownloadUrl
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL download failed with exit code $LASTEXITCODE" }
  } else {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $ArchivePath
  }
}

$actualHash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $ExpectedSha256) {
  throw "PostgreSQL archive checksum mismatch. Expected $ExpectedSha256, got $actualHash"
}

$stage = Join-Path $RuntimeRoot "postgresql-install-$([Guid]::NewGuid().ToString('N'))"
Assert-PathInside $stage $RuntimeRoot | Out-Null
try {
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  $sevenZip = Get-Command 7z.exe -ErrorAction SilentlyContinue
  if ($sevenZip) {
    & $sevenZip.Source x -y "-o$stage" $ArchivePath "pgsql\bin\*" "pgsql\lib\*" "pgsql\share\*" "pgsql\server_license.txt" *> $null
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL archive extraction failed" }
  } else {
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $stage
  }

  $extracted = Join-Path $stage "pgsql"
  if (!(Test-Path -LiteralPath (Join-Path $extracted "bin\postgres.exe"))) {
    throw "PostgreSQL archive has an unexpected structure"
  }

  if (Test-Path -LiteralPath $TargetDir) {
    if (!$Force) { throw "PostgreSQL target already exists but is not version $Version`: $TargetDir" }
    Assert-PathInside $TargetDir $RuntimeRoot | Out-Null
    Remove-Item -LiteralPath $TargetDir -Recurse -Force
  }
  Move-Item -LiteralPath $extracted -Destination $TargetDir
  @{
    product = "PostgreSQL"
    version = $Version
    distribution = "EDB Windows x86-64 binary archive"
    source = $DownloadUrl
    archiveSha256 = $ExpectedSha256
    archiveBytes = (Get-Item -LiteralPath $ArchivePath).Length
    installedAt = (Get-Date).ToString("yyyy-MM-dd")
    scope = "$ProjectRoot project runtime only"
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $TargetDir "AMB_RUNTIME_METADATA.json") -Encoding UTF8

  if (!(Test-InstalledRuntime)) { throw "PostgreSQL $Version runtime validation failed" }
  Write-Host "PostgreSQL $Version installed in $TargetDir"
} finally {
  if (Test-Path -LiteralPath $stage) {
    Assert-PathInside $stage $RuntimeRoot | Out-Null
    Remove-Item -LiteralPath $stage -Recurse -Force
  }
}
