[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$RunId = "pipeline-$((Get-Date).ToString('yyyyMMddHHmmss'))-$([Guid]::NewGuid().ToString('N').Substring(0, 6))"
$RunRoot = Join-Path $ProjectRoot ".runtime\pipeline-acceptance\$RunId"
$PgData = Join-Path $RunRoot "pgdata"
$PgLog = Join-Path $RunRoot "postgres.log"
$RedisLog = Join-Path $RunRoot "redis.log"
$RedisConfig = Join-Path $RunRoot "redis.conf"
$DatabaseName = "amb_pipeline_test"
$DatabaseUser = "amb_test"
$RedisProcess = $null

function Resolve-Executable([string]$Name, [string[]]$Candidates) {
  foreach ($candidate in $Candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return [IO.Path]::GetFullPath($candidate) }
  }
  $command = Get-Command "$Name.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  throw "$Name.exe is required for the isolated pipeline acceptance stand"
}

function Get-FreeTcpPort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

function ConvertTo-MsysPath([string]$Path) {
  $resolved = [IO.Path]::GetFullPath($Path).Replace("\", "/")
  if ($resolved -match "^([A-Za-z]):/(.*)$") {
    return "/cygdrive/$($Matches[1].ToLowerInvariant())/$($Matches[2])"
  }
  return $resolved
}

function Wait-TcpPort([int]$Port, [string]$Label) {
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
      $task = $client.ConnectAsync("127.0.0.1", $Port)
      if ($task.Wait(300) -and $client.Connected) { return }
    } catch {
    } finally {
      $client.Dispose()
    }
    Start-Sleep -Milliseconds 150
  }
  throw "$Label did not open 127.0.0.1:$Port"
}

function Invoke-Amb([string[]]$Arguments) {
  & (Join-Path $ProjectRoot "amb.cmd") @Arguments
  if ($LASTEXITCODE -ne 0) { throw "amb.cmd $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

$PgCtl = Resolve-Executable "pg_ctl" @((Join-Path $ProjectRoot ".runtime\postgresql\bin\pg_ctl.exe"), "D:\PostgreSQL\bin\pg_ctl.exe", "C:\Program Files\PostgreSQL\17\bin\pg_ctl.exe")
$PgBin = Split-Path -Parent $PgCtl
$InitDb = Resolve-Executable "initdb" @((Join-Path $PgBin "initdb.exe"))
$CreateDb = Resolve-Executable "createdb" @((Join-Path $PgBin "createdb.exe"))
$Psql = Resolve-Executable "psql" @((Join-Path $PgBin "psql.exe"))
$WingetRedis = $null
if ($env:LOCALAPPDATA) {
  $WingetRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  if (Test-Path -LiteralPath $WingetRoot) {
    $WingetRedis = Get-ChildItem -LiteralPath $WingetRoot -Depth 5 -Filter "redis-server.exe" -File -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending | Select-Object -ExpandProperty FullName -First 1
  }
}
$RedisServer = Resolve-Executable "redis-server" @($WingetRedis, "C:\Program Files\Redis\redis-server.exe", "D:\Redis\redis-server.exe")
$RedisCli = Resolve-Executable "redis-cli" @((Join-Path (Split-Path -Parent $RedisServer) "redis-cli.exe"))
$RedisVersionText = (& $RedisServer --version | Out-String)
$RedisVersionMatch = [regex]::Match($RedisVersionText, 'v=(\d+)\.')
if (!$RedisVersionMatch.Success -or [int]$RedisVersionMatch.Groups[1].Value -lt 6) {
  throw "BullMQ integration requires Redis 6 or newer; selected server reports: $($RedisVersionText.Trim())"
}
$PgPort = Get-FreeTcpPort
$RedisPort = Get-FreeTcpPort
if ($RedisPort -eq $PgPort) { $RedisPort = Get-FreeTcpPort }

$PreviousEnvironment = @{}
$EnvironmentKeys = @(
  "DATABASE_URL", "REDIS_URL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID",
  "AMB_PIPELINE_INTEGRATION_TEST", "AMB_TEST_PG_CTL", "AMB_TEST_PG_DATA", "AMB_TEST_PG_LOG",
  "AMB_TEST_PSQL",
  "AMB_TEST_REDIS_SERVER", "AMB_TEST_REDIS_CLI", "AMB_TEST_REDIS_CONFIG", "AMB_TEST_REDIS_PORT",
  "AMB_TEST_PROGRESS_LOG",
  "FAST_INLINE_TELEGRAM_SEND_ENABLED", "FAST_INLINE_TELEGRAM_DEADLINE_MS",
  "TELEGRAM_LISTING_SEND_MIN_INTERVAL_MS", "NHTSA_VPIC_ENABLED", "NHTSA_RECALLS_ENABLED",
  "NHTSA_COMPLAINTS_ENABLED", "NHTSA_SAFETY_RATINGS_ENABLED", "DATA_GOV_UA_STOLEN_ENABLED",
  "PHOTO_IDENTIFIER_OCR_ENABLED"
)
foreach ($key in $EnvironmentKeys) { $PreviousEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, "Process") }

try {
  New-Item -ItemType Directory -Force -Path $RunRoot | Out-Null
  & $InitDb -D $PgData -U $DatabaseUser -A trust --encoding UTF8 --no-locale *> (Join-Path $RunRoot "initdb.log")
  if ($LASTEXITCODE -ne 0) { throw "initdb failed; see $RunRoot\initdb.log" }
  @(
    "listen_addresses = '127.0.0.1'"
    "port = $PgPort"
    "fsync = off"
    "synchronous_commit = off"
    "full_page_writes = off"
    "max_connections = 30"
  ) | Add-Content -LiteralPath (Join-Path $PgData "postgresql.conf") -Encoding ASCII
  & $PgCtl start -D $PgData -l $PgLog -w
  if ($LASTEXITCODE -ne 0) { throw "Isolated PostgreSQL failed to start; see $PgLog" }
  Wait-TcpPort $PgPort "Isolated PostgreSQL"
  & $CreateDb -h 127.0.0.1 -p $PgPort -U $DatabaseUser $DatabaseName
  if ($LASTEXITCODE -ne 0) { throw "Could not create isolated PostgreSQL database" }

  @(
    "bind 127.0.0.1"
    "port $RedisPort"
    "dir $(ConvertTo-MsysPath $RunRoot)"
    'save ""'
    "appendonly no"
    "daemonize no"
    "logfile `"$(ConvertTo-MsysPath $RedisLog)`""
  ) | Set-Content -LiteralPath $RedisConfig -Encoding ASCII
  $RedisConfigArgument = ConvertTo-MsysPath $RedisConfig
  $RedisProcess = Start-Process -FilePath $RedisServer -WindowStyle Hidden -PassThru -ArgumentList @($RedisConfigArgument)
  Wait-TcpPort $RedisPort "Isolated Redis"

  $env:DATABASE_URL = "postgresql://${DatabaseUser}@127.0.0.1:${PgPort}/${DatabaseName}?schema=public&connect_timeout=2"
  $env:REDIS_URL = "redis://127.0.0.1:$RedisPort"
  $env:TELEGRAM_BOT_TOKEN = "test-token"
  $env:TELEGRAM_CHAT_ID = "1"
  $env:AMB_PIPELINE_INTEGRATION_TEST = "1"
  $env:AMB_TEST_PG_CTL = $PgCtl
  $env:AMB_TEST_PG_DATA = $PgData
  $env:AMB_TEST_PG_LOG = $PgLog
  $env:AMB_TEST_PSQL = $Psql
  $env:AMB_TEST_REDIS_SERVER = $RedisServer
  $env:AMB_TEST_REDIS_CLI = $RedisCli
  $env:AMB_TEST_REDIS_CONFIG = $RedisConfigArgument
  $env:AMB_TEST_REDIS_PORT = "$RedisPort"
  $env:AMB_TEST_PROGRESS_LOG = (Join-Path $RunRoot "progress.log")
  $env:FAST_INLINE_TELEGRAM_SEND_ENABLED = "true"
  $env:FAST_INLINE_TELEGRAM_DEADLINE_MS = "5000"
  $env:TELEGRAM_LISTING_SEND_MIN_INTERVAL_MS = "250"
  $env:NHTSA_VPIC_ENABLED = "false"
  $env:NHTSA_RECALLS_ENABLED = "false"
  $env:NHTSA_COMPLAINTS_ENABLED = "false"
  $env:NHTSA_SAFETY_RATINGS_ENABLED = "false"
  $env:DATA_GOV_UA_STOLEN_ENABLED = "false"
  $env:PHOTO_IDENTIFIER_OCR_ENABLED = "false"

  Push-Location $ProjectRoot
  try {
    # Historical migrations were created over time and their directory names
    # do not form a clean lexical bootstrap order. The isolated stand therefore
    # materializes the current Prisma schema, then installs the current OLX
    # transactional trigger explicitly.
    Invoke-Amb @("db:push")
    & $Psql -h 127.0.0.1 -p $PgPort -U $DatabaseUser -d $DatabaseName -v ON_ERROR_STOP=1 -f (Join-Path $ProjectRoot "packages\db\prisma\migrations\20260727_zz_olx_known_ids_recovery_guard\migration.sql")
    if ($LASTEXITCODE -ne 0) { throw "Could not install the OLX 2000-ID recovery trigger in the isolated database" }
    Invoke-Amb @("--filter", "@amb/worker", "exec", "tsx", "../../tests/integration/pipeline-resilience.ts")
    Invoke-Amb @("db:verify:olx-reset")
  } finally {
    Pop-Location
  }
  Write-Host "Extended pipeline acceptance passed with isolated PostgreSQL:$PgPort and Redis:$RedisPort."
} finally {
  $RedisStop = Start-Process -FilePath $RedisCli -WindowStyle Hidden -PassThru -ArgumentList @("-h", "127.0.0.1", "-p", "$RedisPort", "shutdown", "nosave")
  if (!$RedisStop.WaitForExit(2000)) { $RedisStop.Kill() }
  if ($RedisProcess -and !$RedisProcess.HasExited) { $RedisProcess.Kill() }
  & $PgCtl stop -D $PgData -m fast -w *> $null
  foreach ($key in $EnvironmentKeys) {
    [Environment]::SetEnvironmentVariable($key, $PreviousEnvironment[$key], "Process")
  }
  if (Test-Path -LiteralPath $RunRoot) {
    $ResolvedRunRoot = [IO.Path]::GetFullPath($RunRoot)
    $AllowedRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot ".runtime\pipeline-acceptance")).TrimEnd('\') + '\'
    if (!$ResolvedRunRoot.StartsWith($AllowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove a path outside the integration runtime root: $ResolvedRunRoot"
    }
    Remove-Item -LiteralPath $ResolvedRunRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
