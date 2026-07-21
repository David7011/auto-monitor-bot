param(
  [switch]$Dev,
  [switch]$SkipDatabase,
  [switch]$SkipRedis
)

$ErrorActionPreference = "Stop"
$ProjectRoot = if ($env:PROJECT_ROOT) { (Resolve-Path $env:PROJECT_ROOT).Path } else { (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$LogDir = Join-Path $ProjectRoot ".runtime\logs"
$PidDir = Join-Path $ProjectRoot ".runtime\pids"
$PgData = if ($env:POSTGRES_DATA) { $env:POSTGRES_DATA } else { Join-Path $ProjectRoot ".runtime\pgdata" }
$PostgresPort = if ($env:POSTGRES_PORT) { [int]$env:POSTGRES_PORT } else { 55432 }
$RedisDir = Join-Path $ProjectRoot ".runtime\redis"
$RedisRuntimeDir = Join-Path $ProjectRoot ".runtime\redis-modern"
$RedisPort = 6380
$NodeRuntimeDir = Join-Path $ProjectRoot ".runtime\node"
$EnsureNodeRuntimeScript = Join-Path $PSScriptRoot "ensure-node-runtime.ps1"
$ProcessManagementScript = Join-Path $PSScriptRoot "process-management.ps1"
$StartLockPath = Join-Path $ProjectRoot ".runtime\start.lock"

New-Item -ItemType Directory -Force -Path $LogDir, $PidDir, $RedisDir, $NodeRuntimeDir | Out-Null
. $ProcessManagementScript

try {
  $script:StartLock = [IO.File]::Open(
    $StartLockPath,
    [IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite,
    [IO.FileShare]::None
  )
} catch {
  Write-Host "Another Auto Monitor Bot startup is already in progress; this request was coalesced."
  exit 0
}

function Add-PathIfExists([string]$Path) {
  if (!$Path -or !(Test-Path -LiteralPath $Path)) { return }
  $parts = $env:PATH -split ";"
  foreach ($part in $parts) {
    if ($part -and $part.Equals($Path, [System.StringComparison]::OrdinalIgnoreCase)) { return }
  }
  $env:PATH = "$Path;$env:PATH"
}

function Set-NodeRuntimeOnD {
  $paths = @(
    (Join-Path $NodeRuntimeDir "tmp"),
    (Join-Path $NodeRuntimeDir "npm-cache"),
    (Join-Path $NodeRuntimeDir "npm-prefix"),
    (Join-Path $NodeRuntimeDir "pnpm-home"),
    (Join-Path $NodeRuntimeDir "pnpm-cache"),
    (Join-Path $NodeRuntimeDir "pnpm-state")
  )
  foreach ($path in $paths) {
    New-Item -ItemType Directory -Force -Path $path | Out-Null
  }

  $env:TEMP = Join-Path $NodeRuntimeDir "tmp"
  $env:TMP = $env:TEMP
  $env:npm_config_cache = Join-Path $NodeRuntimeDir "npm-cache"
  $env:npm_config_prefix = Join-Path $NodeRuntimeDir "npm-prefix"
  $env:npm_config_userconfig = Join-Path $ProjectRoot ".npmrc"
  $env:npm_config_loglevel = "error"
  $env:PNPM_HOME = Join-Path $NodeRuntimeDir "pnpm-home"
  $env:PNPM_STORE_PATH = "D:\.pnpm-store"
  $env:NO_UPDATE_NOTIFIER = "1"

  if (!(Test-Path -LiteralPath $EnsureNodeRuntimeScript)) {
    throw "Pinned runtime bootstrap is missing: $EnsureNodeRuntimeScript"
  }
  $runtime = & $EnsureNodeRuntimeScript -ProjectRoot $ProjectRoot
  $script:NodeExe = $runtime.NodeExe
  $script:PnpmCmd = $runtime.PnpmCmd
  Add-PathIfExists "C:\Program Files\nodejs"
  Add-PathIfExists $env:npm_config_prefix
  Add-PathIfExists $env:PNPM_HOME

  $usersRoot = "C:\Users"
  if (Test-Path -LiteralPath $usersRoot) {
    Get-ChildItem -LiteralPath $usersRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      Add-PathIfExists (Join-Path $_.FullName "AppData\Local\Programs\nodejs")
      Add-PathIfExists (Join-Path $_.FullName "AppData\Roaming\npm")
    }
  }

  # Pinned project runtimes must be first. System Corepack shims can otherwise
  # intercept nested pnpm calls and block a SYSTEM startup while downloading.
  $nodeHome = Split-Path -Parent $script:NodeExe
  $pnpmHome = Split-Path -Parent $script:PnpmCmd
  $env:PATH = (($env:PATH -split ";") | Where-Object {
    $_ -and !$_.Equals($nodeHome, [System.StringComparison]::OrdinalIgnoreCase) -and
      !$_.Equals($pnpmHome, [System.StringComparison]::OrdinalIgnoreCase)
  }) -join ";"
  Add-PathIfExists $nodeHome
  Add-PathIfExists $pnpmHome
}

Set-NodeRuntimeOnD

function Test-Port([int]$Port) {
  return [bool](Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Wait-Port([int]$Port, [int]$TimeoutSeconds, [string]$Name) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Port $Port) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "$Name is not reachable on port $Port"
}

function Stop-AppProcesses {
  Stop-AmbAppProcesses -ProjectRoot $ProjectRoot -PidDir $PidDir
}

function Start-Postgres {
  if (Test-Port $PostgresPort) { return }
  $pgCtl = Resolve-PostgresCtl
  if (!(Test-Path $pgCtl)) {
    Write-Warning "PostgreSQL pg_ctl.exe not found. Set POSTGRES_BIN or start PostgreSQL manually."
    return
  }
  if (!(Test-Path $PgData)) {
    Write-Warning "PostgreSQL data directory not found: $PgData"
    return
  }
  $log = Join-Path $LogDir "postgres.log"
  Start-Process -FilePath $pgCtl -WindowStyle Hidden -ArgumentList @("start", "-D", $PgData, "-l", $log, "-o", "`"-p $PostgresPort -h 127.0.0.1`"")
}

function Resolve-PostgresCtl {
  if ($env:POSTGRES_BIN) {
    if ((Split-Path -Leaf $env:POSTGRES_BIN) -ieq "pg_ctl.exe") { return $env:POSTGRES_BIN }
    return Join-Path $env:POSTGRES_BIN "pg_ctl.exe"
  }

  $candidates = @(
    "D:\PostgreSQL\bin\pg_ctl.exe",
    "C:\Program Files\PostgreSQL\16\bin\pg_ctl.exe",
    "C:\Program Files\PostgreSQL\15\bin\pg_ctl.exe",
    "C:\Program Files\PostgreSQL\14\bin\pg_ctl.exe"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }

  $command = Get-Command pg_ctl.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return "pg_ctl.exe"
}

function Find-RedisServer {
  if ($env:REDIS_PATH -and (Test-Path $env:REDIS_PATH)) { return $env:REDIS_PATH }

  $projectRedis = Get-ChildItem -LiteralPath $RedisRuntimeDir -Recurse -Filter "redis-server.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if ($projectRedis) { return $projectRedis.FullName }

  $explicitCandidates = @(
    "D:\Redis\redis-server.exe",
    "D:\redis\redis-server.exe"
  )
  foreach ($candidate in $explicitCandidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }

  $wingetRoots = @()
  if ($env:LOCALAPPDATA) {
    $wingetRoots += (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages")
  }
  $usersRoot = "C:\Users"
  if (Test-Path -LiteralPath $usersRoot) {
    Get-ChildItem -LiteralPath $usersRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $wingetRoots += (Join-Path $_.FullName "AppData\Local\Microsoft\WinGet\Packages")
    }
  }

  foreach ($wingetRoot in ($wingetRoots | Select-Object -Unique)) {
    if (Test-Path -LiteralPath $wingetRoot) {
      $found = Get-ChildItem -LiteralPath $wingetRoot -Recurse -Filter "redis-server.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending |
        Select-Object -First 1
      if ($found) { return $found.FullName }
    }
  }

  $fallbackCandidates = @(
    "C:\Program Files\Redis\redis-server.exe",
    "C:\Program Files\Memurai\memurai.exe"
  )
  foreach ($candidate in $fallbackCandidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }

  $command = Get-Command redis-server.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  return $null
}

function Stop-IncompatibleRedis {
  $connections = Get-NetTCPConnection -LocalPort $RedisPort -State Listen -ErrorAction SilentlyContinue
  foreach ($connection in $connections) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
    if (!$proc -or $proc.Name -ne "redis-server.exe") { continue }
    $line = if ($null -eq $proc.CommandLine) { "" } else { $proc.CommandLine }
    if ($line -like "*$ProjectRoot*" -or $line -like "*$(ConvertTo-MsysPath $ProjectRoot)*") { return }

    $service = Get-CimInstance Win32_Service | Where-Object { $_.ProcessId -eq $proc.ProcessId } | Select-Object -First 1
    if ($service) {
      Stop-Service -Name $service.Name -Force -ErrorAction SilentlyContinue
      Write-Host "Stopped incompatible Redis service $($service.Name)"
      Start-Sleep -Seconds 1
    }
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped incompatible Redis process $($proc.ProcessId)"
  }
}

function ConvertTo-MsysPath([string]$Path) {
  $resolved = $Path.Replace("\", "/")
  if ($resolved -match "^([A-Za-z]):/(.*)$") {
    return "/cygdrive/$($Matches[1].ToLowerInvariant())/$($Matches[2])"
  }
  return $resolved
}

function Start-Redis {
  if (Test-Port $RedisPort) { return }
  Stop-IncompatibleRedis
  if (Test-Port $RedisPort) { return }
  $redis = Find-RedisServer
  if (!$redis) {
    Write-Warning "redis-server.exe not found. Install Redis or start it manually."
    return
  }

  $config = Join-Path $RedisDir "redis.conf"
  $redisLog = (Join-Path $LogDir "redis.log").Replace("\", "/")
  $redisData = $RedisDir.Replace("\", "/")
  $redisConfig = ConvertTo-MsysPath $config
  @"
bind 127.0.0.1
protected-mode yes
port $RedisPort
dir $redisData
appendonly yes
appendfsync everysec
maxmemory-policy noeviction
logfile "$redisLog"
"@ | Set-Content -LiteralPath $config -Encoding ascii

  Start-Process -FilePath $redis -WindowStyle Hidden -ArgumentList @($redisConfig)
}

function Start-App([string]$Name, [string]$Command, [string]$OutLog, [string]$ErrLog) {
  $cmd = "cd /d `"$ProjectRoot`" && $Command > `"$OutLog`" 2> `"$ErrLog`""
  $process = Start-Process -FilePath cmd.exe -WindowStyle Hidden -ArgumentList @("/c", $cmd) -PassThru
  Set-Content -LiteralPath (Join-Path $PidDir "$Name.pid") -Value $process.Id -Encoding ascii
  Write-Host "Started $Name"
}

function Start-NodeApp(
  [string]$Name,
  [string]$WorkingDirectory,
  [string[]]$Arguments,
  [string]$OutLog,
  [string]$ErrLog
) {
  $node = $script:NodeExe
  if (!$node -or !(Test-Path -LiteralPath $node)) { throw "Pinned Node.js runtime is unavailable" }
  $process = Start-Process `
    -FilePath $node `
    -WindowStyle Hidden `
    -WorkingDirectory $WorkingDirectory `
    -ArgumentList $Arguments `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog `
    -PassThru
  Set-Content -LiteralPath (Join-Path $PidDir "$Name.pid") -Value $process.Id -Encoding ascii
  Write-Host "Started $Name (PID $($process.Id))"
}

function Invoke-Pnpm([string[]]$Arguments) {
  Push-Location $ProjectRoot
  try {
    & $script:PnpmCmd @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "pnpm@10.0.0 $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Get-PnpmCommand([string[]]$Arguments) {
  return "`"$script:PnpmCmd`" $($Arguments -join ' ')"
}

function Test-PrismaClientGenerated {
  $prismaSevenClient = Join-Path $ProjectRoot "packages\db\src\generated\prisma\client.ts"
  if (Test-Path -LiteralPath $prismaSevenClient) {
    $generatedAt = (Get-Item -LiteralPath $prismaSevenClient).LastWriteTimeUtc
    $inputs = @(
      (Join-Path $ProjectRoot "packages\db\prisma\schema.prisma"),
      (Join-Path $ProjectRoot "packages\db\prisma.config.ts"),
      (Join-Path $ProjectRoot "pnpm-lock.yaml")
    )
    $stale = $inputs | Where-Object { (Test-Path -LiteralPath $_) -and (Get-Item -LiteralPath $_).LastWriteTimeUtc -gt $generatedAt }
    if (!$stale) { return $true }
  }

  $pnpmRoot = Join-Path $ProjectRoot "node_modules\.pnpm"
  if (!(Test-Path -LiteralPath $pnpmRoot)) { return $false }

  $clientPackage = Get-ChildItem -LiteralPath $pnpmRoot -Directory -Filter "@prisma+client*" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (!$clientPackage) { return $false }

  $clientDir = Join-Path $clientPackage.FullName "node_modules\.prisma\client"
  $expected = @(
    (Join-Path $clientDir "index.js"),
    (Join-Path $clientDir "query_engine-windows.dll.node")
  )

  foreach ($path in $expected) {
    if (!(Test-Path -LiteralPath $path)) { return $false }
  }
  return $true
}

function Ensure-PrismaClientGenerated {
  if (Test-PrismaClientGenerated) {
    Write-Host "Prisma client already generated; skipping db:generate"
    return
  }
  Invoke-Pnpm @("db:generate")
}

function Clear-DashboardBuildCache {
  $paths = @(
    (Join-Path $ProjectRoot "apps\dashboard\.next"),
    (Join-Path $ProjectRoot "apps\dashboard\tsconfig.tsbuildinfo")
  )

  foreach ($path in $paths) {
    if (!(Test-Path -LiteralPath $path)) { continue }
    $resolved = (Resolve-Path -LiteralPath $path).Path
    if (!$resolved.StartsWith($ProjectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove path outside project root: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}

function Test-ProductionBuilds {
  $expected = @(
    (Join-Path $ProjectRoot "packages\shared\dist\index.js"),
    (Join-Path $ProjectRoot "packages\db\dist\index.js"),
    (Join-Path $ProjectRoot "apps\api\dist\server.js"),
    (Join-Path $ProjectRoot "apps\worker\dist\index.js"),
    (Join-Path $ProjectRoot "apps\dashboard\.next\BUILD_ID")
  )

  foreach ($path in $expected) {
    if (!(Test-Path -LiteralPath $path)) { return $false }
  }
  return $true
}

function Ensure-ProductionBuilds {
  if (Test-ProductionBuilds) { return }
  Write-Host "Production builds are missing; running pnpm build"
  Invoke-Pnpm @("build")
}

function Get-DotEnvValue([string]$Name) {
  $envPath = Join-Path $ProjectRoot ".env"
  if (!(Test-Path $envPath)) { return $null }
  $line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match "^\s*$Name\s*=" } | Select-Object -First 1
  if (!$line) { return $null }
  return ($line -replace "^\s*$Name\s*=\s*", "").Trim().Trim('"').Trim("'")
}

function Import-ProjectDotEnv {
  $envPath = Join-Path $ProjectRoot ".env"
  if (!(Test-Path -LiteralPath $envPath)) { return }
  foreach ($line in (Get-Content -LiteralPath $envPath -Encoding UTF8)) {
    if ($line -notmatch "^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$") { continue }
    $name = $Matches[1]
    $value = $Matches[2].Trim()
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'")))) {
      $value = $value.Substring(1, $value.Length - 2)
    } else {
      $value = ($value -replace "\s+#.*$", "").Trim()
    }
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}

& $script:NodeExe (Join-Path $PSScriptRoot "ensure-local-secrets.mjs") | Out-Null
Import-ProjectDotEnv
$configuredRedisUrl = Get-DotEnvValue "REDIS_URL"
if ($configuredRedisUrl) {
  try {
    $parsedRedisUrl = [Uri]$configuredRedisUrl
    if ($parsedRedisUrl.Port -gt 0) { $RedisPort = $parsedRedisUrl.Port }
  } catch {}
}

Stop-AppProcesses
Start-Sleep -Seconds 1

if (!$SkipDatabase) { Start-Postgres }
if (!$SkipRedis) { Start-Redis }

Wait-Port $PostgresPort 20 "PostgreSQL"
Wait-Port $RedisPort 20 "Redis"
Ensure-PrismaClientGenerated
Invoke-Pnpm @("db:migrate:deploy")

if ($Dev) {
  Clear-DashboardBuildCache
  Start-App "API" (Get-PnpmCommand @("dev:api")) (Join-Path $LogDir "api.out.log") (Join-Path $LogDir "api.err.log")
  Start-App "Worker" (Get-PnpmCommand @("worker")) (Join-Path $LogDir "worker.out.log") (Join-Path $LogDir "worker.err.log")
  Start-App "Dashboard" (Get-PnpmCommand @("dev")) (Join-Path $LogDir "dashboard.out.log") (Join-Path $LogDir "dashboard.err.log")
} else {
  Ensure-ProductionBuilds
  $env:NODE_ENV = "production"
  Start-NodeApp "API" (Join-Path $ProjectRoot "apps\api") @("--conditions=production", (Join-Path $ProjectRoot "apps\api\dist\server.js")) (Join-Path $LogDir "api.out.log") (Join-Path $LogDir "api.err.log")
  Start-NodeApp "Worker" (Join-Path $ProjectRoot "apps\worker") @("--conditions=production", (Join-Path $ProjectRoot "apps\worker\dist\index.js")) (Join-Path $LogDir "worker.out.log") (Join-Path $LogDir "worker.err.log")
  Start-NodeApp "Dashboard" (Join-Path $ProjectRoot "apps\dashboard") @((Join-Path $ProjectRoot "apps\dashboard\node_modules\next\dist\bin\next"), "start", "-H", "127.0.0.1", "-p", "3001") (Join-Path $LogDir "dashboard.out.log") (Join-Path $LogDir "dashboard.err.log")
}

& (Join-Path $PSScriptRoot "wait-core-readiness.ps1") -TimeoutSeconds 90 -StableChecks 2
if ($LASTEXITCODE -ne 0) { throw "Services started but core readiness verification failed" }
