$ErrorActionPreference = "Stop"
$ProjectRoot = if ($env:PROJECT_ROOT) {
  (Resolve-Path $env:PROJECT_ROOT).Path
} else {
  (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RuntimeRoot = Join-Path $ProjectRoot ".runtime"
$PidDir = Join-Path $RuntimeRoot "pids"
$LogDir = Join-Path $RuntimeRoot "logs"
$LogPath = Join-Path $LogDir "watchdog.log"
$LockPath = Join-Path $RuntimeRoot "watchdog.lock"
$StatePath = Join-Path $RuntimeRoot "watchdog-state.json"
$SupervisorScript = Join-Path $ProjectRoot "scripts\supervisor.ps1"
$SupervisorTaskName = "Auto Monitor Bot"
$SupervisorLockPath = Join-Path $RuntimeRoot "supervisor.lock"
$ValidationLockPath = Join-Path $RuntimeRoot "validation.lock"
$StartLockPath = Join-Path $RuntimeRoot "start.lock"
$SupervisorHeartbeatPath = Join-Path $RuntimeRoot "supervisor-heartbeat.json"
$ProcessManagementScript = Join-Path $PSScriptRoot "process-management.ps1"
$RuntimeIntentScript = Join-Path $PSScriptRoot "runtime-intent.ps1"
$AlertPolicyScript = Join-Path $PSScriptRoot "watchdog-alert-policy.ps1"

. $ProcessManagementScript
. $RuntimeIntentScript
. $AlertPolicyScript

New-Item -ItemType Directory -Force -Path $RuntimeRoot, $LogDir | Out-Null

function Write-WatchdogLog([string]$Message) {
  if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -ge 5MB) {
    for ($index = 4; $index -ge 1; $index -= 1) {
      $source = "$LogPath.$index"
      $destination = "$LogPath.$($index + 1)"
      if (Test-Path -LiteralPath $source) { Move-Item -LiteralPath $source -Destination $destination -Force }
    }
    Move-Item -LiteralPath $LogPath -Destination "$LogPath.1" -Force
  }
  $line = "{0} {1}{2}" -f (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK"), $Message, [Environment]::NewLine
  [IO.File]::AppendAllText($LogPath, $line, [Text.UTF8Encoding]::new($false))
}

function Test-LockHeld([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { return $false }
  $probe = $null
  try {
    $probe = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    return $false
  } catch {
    return $true
  } finally {
    if ($probe) { $probe.Dispose() }
  }
}

function Test-SupervisorHeartbeatFresh {
  if (!(Test-Path -LiteralPath $SupervisorHeartbeatPath)) { return $false }
  try {
    $heartbeat = Get-Content -LiteralPath $SupervisorHeartbeatPath -Encoding UTF8 -Raw | ConvertFrom-Json
    if (!$heartbeat.checkedAt) { return $false }
    return ([datetime]$heartbeat.checkedAt) -ge (Get-Date).AddSeconds(-30)
  } catch {
    return $false
  }
}

function Read-WatchdogState {
  if (!(Test-Path -LiteralPath $StatePath)) {
    return [pscustomobject]@{
      failureCount = 0
      nextAttemptAt = $null
      lastAlertAt = $null
      sourceAlertKey = $null
      lastSourceAlertAt = $null
    }
  }
  try {
    return Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return [pscustomobject]@{
      failureCount = 0
      nextAttemptAt = $null
      lastAlertAt = $null
      sourceAlertKey = $null
      lastSourceAlertAt = $null
    }
  }
}

function Write-WatchdogState(
  [int]$FailureCount,
  [Nullable[datetime]]$NextAttemptAt,
  [Nullable[datetime]]$LastAlertAt,
  [AllowNull()][string]$SourceAlertKey = $null,
  [Nullable[datetime]]$LastSourceAlertAt = $null
) {
  @{
    failureCount = $FailureCount
    nextAttemptAt = if ($NextAttemptAt) { ([datetime]$NextAttemptAt).ToString("o") } else { $null }
    lastAlertAt = if ($LastAlertAt) { ([datetime]$LastAlertAt).ToString("o") } else { $null }
    sourceAlertKey = $SourceAlertKey
    lastSourceAlertAt = if ($LastSourceAlertAt) { ([datetime]$LastSourceAlertAt).ToString("o") } else { $null }
  } | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding UTF8
}

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

function Wait-TelegramGlobalSlot([string]$Token, [string]$ChatId) {
  $redisUrl = if ($env:REDIS_URL) { $env:REDIS_URL } else { Get-DotEnvValue "REDIS_URL" }
  if (!$redisUrl) { $redisUrl = "redis://127.0.0.1:6380" }
  $intervalText = if ($env:TELEGRAM_LISTING_SEND_MIN_INTERVAL_MS) {
    $env:TELEGRAM_LISTING_SEND_MIN_INTERVAL_MS
  } else {
    Get-DotEnvValue "TELEGRAM_LISTING_SEND_MIN_INTERVAL_MS"
  }
  $intervalMs = 1100
  $parsedInterval = 0
  if ([int]::TryParse($intervalText, [ref]$parsedInterval)) {
    $intervalMs = [Math]::Max(250, [Math]::Min(5000, $parsedInterval))
  }

  try {
    $uri = [Uri]$redisUrl
    $redisCli = Get-ChildItem -LiteralPath (Join-Path $RuntimeRoot "redis-modern") `
      -Filter "redis-cli.exe" -File -Recurse -ErrorAction Stop |
      Select-Object -First 1 -ExpandProperty FullName
    if (!$redisCli) { throw "redis-cli.exe not found" }
    $port = if ($uri.Port -gt 0) { $uri.Port } else { 6379 }
    $database = 0
    $databaseText = $uri.AbsolutePath.Trim("/")
    if ($databaseText) { [void][int]::TryParse($databaseText, [ref]$database) }
    $botId = (($Token -split ":", 2)[0] -replace "[^0-9]", "")
    if (!$botId) { $botId = "unconfigured" }
    $safeChatId = ($ChatId -replace "[^0-9-]", "_")
    if (!$safeChatId) { $safeChatId = "unconfigured" }
    $key = "amb:telegram:rate:v1:$botId`:$safeChatId"
    $lua = 'local t=redis.call("TIME"); local n=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000); local i=math.max(0,tonumber(ARGV[1]) or 0); local c=tonumber(redis.call("GET",KEYS[1])) or 0; local s=math.max(n,c); local x=s+i; local ttl=math.max(5000,x-n+i*4); redis.call("SET",KEYS[1],tostring(x),"PX",tostring(ttl)); return s-n'
    $arguments = @("--raw", "--no-auth-warning", "-h", $uri.Host, "-p", $port, "-n", $database)
    $previousRedisAuth = $env:REDISCLI_AUTH
    try {
      if ($uri.UserInfo) {
        $credentials = $uri.UserInfo -split ":", 2
        if ($credentials[0]) { $arguments += @("--user", [Uri]::UnescapeDataString($credentials[0])) }
        if ($credentials.Count -gt 1 -and $credentials[1]) {
          $env:REDISCLI_AUTH = [Uri]::UnescapeDataString($credentials[1])
        }
      }
      $result = & $redisCli @arguments "EVAL" $lua 1 $key $intervalMs 2>&1
      if ($LASTEXITCODE -ne 0) { throw ($result | Out-String) }
    } finally {
      $env:REDISCLI_AUTH = $previousRedisAuth
    }
    $delayMs = 0
    if (![int]::TryParse(($result | Select-Object -Last 1), [ref]$delayMs)) {
      throw "invalid Redis rate-gate response"
    }
    if ($delayMs -gt 0) { Start-Sleep -Milliseconds $delayMs }
    return $true
  } catch {
    # Ordinary API/worker sends fail closed when Redis is unavailable. The
    # single-instance watchdog remains the emergency alert path in that case.
    Write-WatchdogLog "Telegram global rate gate unavailable; using watchdog emergency path: $($_.Exception.Message)"
    return $false
  }
}

function Send-WatchdogAlert([string]$Message) {
  $token = if ($env:TELEGRAM_BOT_TOKEN) { $env:TELEGRAM_BOT_TOKEN } else { Get-DotEnvValue "TELEGRAM_BOT_TOKEN" }
  $chatId = if ($env:TELEGRAM_CHAT_ID) { $env:TELEGRAM_CHAT_ID } else { Get-DotEnvValue "TELEGRAM_CHAT_ID" }
  if (!$token -or !$chatId) { return $false }
  try {
    [void](Wait-TelegramGlobalSlot -Token $token -ChatId $chatId)
    $payload = @{
      chat_id = $chatId
      text = $Message
      disable_web_page_preview = $true
    } | ConvertTo-Json -Compress
    $utf8Payload = [Text.Encoding]::UTF8.GetBytes($payload)
    Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/sendMessage" `
      -ContentType "application/json; charset=utf-8" -Body $utf8Payload -TimeoutSec 10 | Out-Null
    return $true
  } catch {
    Write-WatchdogLog "external alert failed: $($_.Exception.Message)"
    return $false
  }
}

$lock = $null
try {
  $lock = [IO.File]::Open($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch {
  exit 0
}

try {
  if (!(Test-AmbRunIntent)) {
    Write-WatchdogState -FailureCount 0 -NextAttemptAt $null -LastAlertAt $null -SourceAlertKey $null -LastSourceAlertAt $null
    exit 0
  }

  $failures = [System.Collections.Generic.List[string]]::new()
  $sourceProtection = @()
  $sourceProtectionSnapshot = $null
  $state = Read-WatchdogState
  $healthAvailable = $false

  $tailscale = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
  if (Test-Path -LiteralPath $tailscale) {
    try {
      $tailscaleStatus = (& $tailscale status --json 2>$null | Out-String) | ConvertFrom-Json
      if ($tailscaleStatus.BackendState -eq "Stopped" -and $tailscaleStatus.HaveNodeKey) {
        & $tailscale up *> $null
        if ($LASTEXITCODE -eq 0) {
          Write-WatchdogLog "remote access restored"
        }
      }
    } catch {
      Write-WatchdogLog "remote access check failed: $($_.Exception.Message)"
    }
  }

  foreach ($name in @("api", "worker-hot-a", "worker-hot-b", "worker-background", "dashboard")) {
    $pidPath = Join-Path $PidDir "$name.pid"
    $recordedPid = 0
    $value = if (Test-Path -LiteralPath $pidPath) {
      Get-Content -LiteralPath $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1
    } else {
      $null
    }
    $parsed = $value -and [int]::TryParse($value, [ref]$recordedPid) -and $recordedPid -gt 0
    if (!$parsed) {
      $failures.Add("process:$name")
      continue
    }

    $recordedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $recordedPid" -ErrorAction SilentlyContinue
    if (!$recordedProcess -or !(Test-AmbOwnedServiceProcess -Process $recordedProcess -ProjectRoot $ProjectRoot -ServiceName $name)) {
      $failures.Add("process:$name")
    }
  }

  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:4000/health" -TimeoutSec 8
    $healthAvailable = $true
    if ($health.api.status -ne "OK") { $failures.Add("health:api") }
    if ($health.database.status -ne "OK") { $failures.Add("health:database") }
    if ($health.redis.status -eq "FAIL") { $failures.Add("health:redis") }
    if ($health.workers.status -eq "FAIL") { $failures.Add("health:workers") }
    $sourceProtectionSnapshot = Get-AmbSourceProtectionSnapshot $health.sourceHealth
    $sourceProtection = @($sourceProtectionSnapshot.Details)
  } catch {
    $failures.Add("health:unreachable")
  }

  if (!(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue)) {
    $failures.Add("dashboard:port")
  }
  if (!(Test-LockHeld $SupervisorLockPath)) {
    $failures.Add("supervisor:inactive")
  }

  $lastSourceAlertAt = if (
    $state.PSObject.Properties.Name -contains "lastSourceAlertAt" -and $state.lastSourceAlertAt
  ) {
    [datetime]$state.lastSourceAlertAt
  } else {
    $null
  }
  $previousSourceAlertKey = if ($state.PSObject.Properties.Name -contains "sourceAlertKey") {
    ConvertTo-AmbCanonicalSourceProtectionKey ([string]$state.sourceAlertKey)
  } else {
    ""
  }
  $sourceAlertKey = if (!$healthAvailable) {
    $previousSourceAlertKey
  } elseif ($sourceProtectionSnapshot) {
    $sourceProtectionSnapshot.Key
  } else {
    $null
  }
  if ($healthAvailable -and $sourceAlertKey) {
    $sourceAlertChanged = $sourceAlertKey -ne $previousSourceAlertKey
    if ($sourceAlertChanged) {
      $watchdogText = Get-AmbWatchdogAlertText
      $sourceAlertMessage = $watchdogText.SourceProtection -f ($sourceProtection -join '; ')
      [void](Send-WatchdogAlert $sourceAlertMessage)
      $lastSourceAlertAt = Get-Date
      Write-WatchdogLog "source protection reported without restart: $($sourceProtection -join ', ')"
    }
  } elseif ($healthAvailable -and $previousSourceAlertKey) {
    $watchdogText = Get-AmbWatchdogAlertText
    [void](Send-WatchdogAlert $watchdogText.SourceProtectionCleared)
    Write-WatchdogLog "source protection cleared"
    $lastSourceAlertAt = $null
  }

  if ($failures.Count -eq 0) {
    Write-WatchdogState -FailureCount 0 -NextAttemptAt $null -LastAlertAt $null -SourceAlertKey $sourceAlertKey -LastSourceAlertAt $lastSourceAlertAt
    exit 0
  }

  if ((Test-LockHeld $ValidationLockPath) -or (Test-LockHeld $StartLockPath)) {
    Write-WatchdogLog "health check deferred while validation or startup is in progress"
    exit 0
  }

  $nextAttemptAt = if ($state.nextAttemptAt) { [datetime]$state.nextAttemptAt } else { $null }
  if ($nextAttemptAt -and $nextAttemptAt -gt (Get-Date)) { exit 0 }

  $failureCount = [Math]::Max(0, [int]$state.failureCount) + 1
  $lastAlertAt = if ($state.PSObject.Properties.Name -contains "lastAlertAt" -and $state.lastAlertAt) {
    [datetime]$state.lastAlertAt
  } else {
    $null
  }
  $delays = @(60, 120, 300, 600, 900, 1800)
  $delaySeconds = $delays[[Math]::Min($failureCount - 1, $delays.Count - 1)]
  if ($failureCount -ge 3 -and (!$lastAlertAt -or $lastAlertAt -lt (Get-Date).AddMinutes(-30))) {
    $watchdogText = Get-AmbWatchdogAlertText
    [void](Send-WatchdogAlert ($watchdogText.LocalFailure -f $failureCount, ($failures -join ',')))
    $lastAlertAt = Get-Date
  }
  Write-WatchdogState -FailureCount $failureCount -NextAttemptAt ((Get-Date).AddSeconds($delaySeconds)) -LastAlertAt $lastAlertAt -SourceAlertKey $sourceAlertKey -LastSourceAlertAt $lastSourceAlertAt

  $supervisorLockHeld = Test-LockHeld $SupervisorLockPath
  $supervisorHeartbeatFresh = Test-SupervisorHeartbeatFresh
  if ($supervisorLockHeld -and $supervisorHeartbeatFresh) {
    Write-WatchdogLog "health failure delegated to active supervisor: $($failures -join ',')"
  } else {
    $reason = if ($supervisorLockHeld) { "supervisor heartbeat is stale" } else { "supervisor was not active" }
    Write-WatchdogLog "$reason; restarting it for: $($failures -join ',')"
    try {
      $supervisorTask = Get-ScheduledTask -TaskName $SupervisorTaskName -ErrorAction Stop
      if ($supervisorTask.State -eq "Running") {
        Stop-ScheduledTask -TaskName $SupervisorTaskName -ErrorAction Stop
        Start-Sleep -Seconds 1
      }
      Start-ScheduledTask -TaskName $SupervisorTaskName -ErrorAction Stop
      Write-WatchdogLog "scheduled supervisor task started"
    } catch {
      Write-WatchdogLog "scheduled supervisor restart failed; using direct fallback: $($_.Exception.Message)"
      $powershell = Join-Path $PSHOME "powershell.exe"
      Start-Process -FilePath $powershell -WindowStyle Hidden -ArgumentList @(
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", $SupervisorScript
      ) | Out-Null
    }
  }
} finally {
  if ($lock) { $lock.Dispose() }
}
