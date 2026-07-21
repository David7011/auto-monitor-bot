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
$AutostartScript = Join-Path $ProjectRoot "scripts\autostart-run.ps1"
$ProcessManagementScript = Join-Path $PSScriptRoot "process-management.ps1"

. $ProcessManagementScript

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

function Read-WatchdogState {
  if (!(Test-Path -LiteralPath $StatePath)) {
    return [pscustomobject]@{ failureCount = 0; nextAttemptAt = $null; lastAlertAt = $null }
  }
  try {
    return Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return [pscustomobject]@{ failureCount = 0; nextAttemptAt = $null; lastAlertAt = $null }
  }
}

function Write-WatchdogState(
  [int]$FailureCount,
  [Nullable[datetime]]$NextAttemptAt,
  [Nullable[datetime]]$LastAlertAt
) {
  @{
    failureCount = $FailureCount
    nextAttemptAt = if ($NextAttemptAt) { ([datetime]$NextAttemptAt).ToString("o") } else { $null }
    lastAlertAt = if ($LastAlertAt) { ([datetime]$LastAlertAt).ToString("o") } else { $null }
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

function Send-WatchdogAlert([string]$Message) {
  $token = if ($env:TELEGRAM_BOT_TOKEN) { $env:TELEGRAM_BOT_TOKEN } else { Get-DotEnvValue "TELEGRAM_BOT_TOKEN" }
  $chatId = if ($env:TELEGRAM_CHAT_ID) { $env:TELEGRAM_CHAT_ID } else { Get-DotEnvValue "TELEGRAM_CHAT_ID" }
  if (!$token -or !$chatId) { return $false }
  try {
    Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/sendMessage" -Body @{
      chat_id = $chatId
      text = $Message
      disable_web_page_preview = "true"
    } -TimeoutSec 10 | Out-Null
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
  $failures = [System.Collections.Generic.List[string]]::new()

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

  foreach ($name in @("api", "worker", "dashboard")) {
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
    if (!$recordedProcess -or !(Test-AmbOwnedProcess -Process $recordedProcess -ProjectRoot $ProjectRoot)) {
      $failures.Add("process:$name")
    }
  }

  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:4000/health" -TimeoutSec 8
    if ($health.api.status -ne "OK") { $failures.Add("health:api") }
    if ($health.database.status -ne "OK") { $failures.Add("health:database") }
    if ($health.redis.status -eq "FAIL") { $failures.Add("health:redis") }
    if ($health.workers.status -eq "FAIL") { $failures.Add("health:workers") }
  } catch {
    $failures.Add("health:unreachable")
  }

  if (!(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue)) {
    $failures.Add("dashboard:port")
  }

  if ($failures.Count -eq 0) {
    Write-WatchdogState -FailureCount 0 -NextAttemptAt $null -LastAlertAt $null
    exit 0
  }

  $state = Read-WatchdogState
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
  $alertSent = $false
  if ($failureCount -ge 3 -and (!$lastAlertAt -or $lastAlertAt -lt (Get-Date).AddMinutes(-30))) {
    $alertSent = Send-WatchdogAlert "Auto Monitor Bot: сбой #$failureCount ($($failures -join ',')). Выполняю восстановление."
    if ($alertSent) { $lastAlertAt = Get-Date }
  }
  Write-WatchdogState -FailureCount $failureCount -NextAttemptAt ((Get-Date).AddSeconds($delaySeconds)) -LastAlertAt $lastAlertAt

  Write-WatchdogLog "restart requested: $($failures -join ',')"
  try {
    $powershell = Join-Path $PSHOME "powershell.exe"
    $restart = Start-Process -FilePath $powershell -WindowStyle Hidden -PassThru -ArgumentList @(
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", $AutostartScript
    )
    # Process.WaitForExit waits only for the bootstrap process. Start-Process
    # -Wait would also wait forever for the long-lived Node descendants.
    $restart.WaitForExit()
    if ($restart.ExitCode -ne 0) { throw "autostart-run.ps1 exited with code $($restart.ExitCode)" }
    if ($alertSent) { Send-WatchdogAlert "Auto Monitor Bot: работа восстановлена." | Out-Null }
    Write-WatchdogState -FailureCount 0 -NextAttemptAt $null -LastAlertAt $null
    Write-WatchdogLog "restart completed"
  } catch {
    Write-WatchdogLog "restart failed: $($_.Exception.Message)"
    throw
  }
} finally {
  if ($lock) { $lock.Dispose() }
}
