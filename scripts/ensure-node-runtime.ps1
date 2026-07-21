param(
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$NodeVersion = "24.18.0",
  [string]$PnpmVersion = "10.0.0"
)

$ErrorActionPreference = "Stop"
$RuntimeRoot = Join-Path $ProjectRoot ".runtime\node-runtime-v2"
$NodeFolderName = "node-v$NodeVersion-win-x64"
$NodeHome = Join-Path $RuntimeRoot $NodeFolderName
$NodeExe = Join-Path $NodeHome "node.exe"
$NpmCmd = Join-Path $NodeHome "npm.cmd"
$PnpmHome = Join-Path $RuntimeRoot "pnpm-$PnpmVersion"
$PnpmCmd = Join-Path $PnpmHome "pnpm.cmd"
$DownloadRoot = Join-Path $RuntimeRoot "downloads"
$InstallLockPath = Join-Path $RuntimeRoot "install.lock"

New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
$InstallLock = $null
$lockDeadline = (Get-Date).AddMinutes(3)
while (!$InstallLock -and (Get-Date) -lt $lockDeadline) {
  try {
    $InstallLock = [IO.File]::Open($InstallLockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch {
    Start-Sleep -Milliseconds 500
  }
}
if (!$InstallLock) { throw "Timed out waiting for the pinned runtime installation lock" }

function Add-RuntimePath([string]$Path) {
  if (!$Path -or !(Test-Path -LiteralPath $Path)) { return }
  $present = ($env:PATH -split ";") | Where-Object {
    $_ -and $_.Equals($Path, [System.StringComparison]::OrdinalIgnoreCase)
  }
  if (!$present) { $env:PATH = "$Path;$env:PATH" }
}

function Unblock-RuntimeFiles {
  # Do not recursively touch the whole runtime on every boot. Besides slowing down
  # startup, that pattern makes endpoint protection rescan thousands of files. The
  # launchers are the only files Windows needs to treat as executable entry points.
  @("node.exe", "npm.cmd", "npx.cmd", "corepack.cmd") | ForEach-Object {
    $launcher = Join-Path $NodeHome $_
    if (Test-Path -LiteralPath $launcher) {
      Unblock-File -LiteralPath $launcher -ErrorAction SilentlyContinue
    }
  }
}

function Install-NodeRuntime {
  New-Item -ItemType Directory -Force -Path $RuntimeRoot, $DownloadRoot | Out-Null
  $archiveName = "$NodeFolderName.zip"
  $archivePath = Join-Path $DownloadRoot $archiveName
  $baseUrl = "https://nodejs.org/dist/v$NodeVersion"
  $checksumsPath = Join-Path $DownloadRoot "SHASUMS256-v$NodeVersion.txt"

  Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -OutFile $checksumsPath -UseBasicParsing
  $checksumLine = Get-Content -LiteralPath $checksumsPath -Encoding ascii |
    Where-Object { $_ -match "\s+$([regex]::Escape($archiveName))$" } |
    Select-Object -First 1
  if (!$checksumLine) { throw "Official SHA-256 for $archiveName was not found" }
  $expectedHash = ($checksumLine -split "\s+")[0].ToLowerInvariant()

  $archiveValid = (Test-Path -LiteralPath $archivePath) -and
    (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -eq $expectedHash
  if (!$archiveValid) {
    $downloadPath = "$archivePath.download-$([guid]::NewGuid().ToString('N'))"
    try {
      Invoke-WebRequest -Uri "$baseUrl/$archiveName" -OutFile $downloadPath -UseBasicParsing
      $downloadHash = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($downloadHash -ne $expectedHash) { throw "Downloaded Node.js archive checksum mismatch" }
      Move-Item -LiteralPath $downloadPath -Destination $archivePath -Force
    } finally {
      Remove-Item -LiteralPath $downloadPath -Force -ErrorAction SilentlyContinue
    }
  }

  # The archive was verified against the official checksum. Remove Mark-of-the-Web
  # before extraction so child files do not inherit it.
  Unblock-File -LiteralPath $archivePath -ErrorAction SilentlyContinue

  $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
    throw "Node.js archive checksum mismatch"
  }

  $staging = Join-Path $RuntimeRoot "extract-$([guid]::NewGuid().ToString('N'))"
  try {
    Expand-Archive -LiteralPath $archivePath -DestinationPath $staging -Force
    $extracted = Join-Path $staging $NodeFolderName
    if (!(Test-Path -LiteralPath (Join-Path $extracted "node.exe"))) {
      throw "Downloaded Node.js archive does not contain node.exe"
    }
    if (Test-Path -LiteralPath $NodeHome) { Remove-Item -LiteralPath $NodeHome -Recurse -Force }
    Move-Item -LiteralPath $extracted -Destination $NodeHome
    Unblock-RuntimeFiles
  } finally {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Install-PnpmRuntime {
  New-Item -ItemType Directory -Force -Path $PnpmHome | Out-Null
  $env:npm_config_prefix = $PnpmHome
  $env:npm_config_cache = Join-Path $RuntimeRoot "npm-cache"
  New-Item -ItemType Directory -Force -Path $env:npm_config_cache | Out-Null
  & $NpmCmd install --global --ignore-scripts --no-audit --no-fund "pnpm@$PnpmVersion"
  if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $PnpmCmd)) {
    throw "Failed to install pinned pnpm@$PnpmVersion runtime"
  }
}

try {
  if (!(Test-Path -LiteralPath $NodeExe)) { Install-NodeRuntime }
  Unblock-RuntimeFiles
  if (!(Test-Path -LiteralPath $PnpmCmd)) { Install-PnpmRuntime }

  $env:AMB_NODE_EXE = $NodeExe
  $env:AMB_PNPM_CMD = $PnpmCmd
  Add-RuntimePath $NodeHome
  Add-RuntimePath $PnpmHome

  & $NodeExe --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Pinned Node.js runtime is not executable" }
  & $PnpmCmd --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Pinned pnpm runtime is not executable" }

  [pscustomobject]@{
    NodeExe = $NodeExe
    PnpmCmd = $PnpmCmd
    NodeVersion = $NodeVersion
    PnpmVersion = $PnpmVersion
  }
} finally {
  $InstallLock.Dispose()
}
