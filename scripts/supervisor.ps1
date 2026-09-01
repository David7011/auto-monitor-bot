param(
  [int]$CheckIntervalSeconds = 3,
  [int]$ConsecutiveFailuresBeforeRestart = 2,
  [int]$ConsecutiveReadinessFailuresBeforeRecovery = 10,
  [int]$WorkerHeartbeatStaleSeconds = 20
)

$ErrorActionPreference = "Stop"
$ProjectRoot = if ($env:PROJECT_ROOT) {
  (Resolve-Path $env:PROJECT_ROOT).Path
} else {
  (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RuntimeRoot = Join-Path $ProjectRoot ".runtime"
$LogDir = Join-Path $RuntimeRoot "logs"
$PidDir = Join-Path $RuntimeRoot "pids"
$LogPath = Join-Path $LogDir "supervisor.log"
$LockPath = Join-Path $RuntimeRoot "supervisor.lock"
$StartScript = Join-Path $PSScriptRoot "start.ps1"
$FastRecoveryScript = Join-Path $PSScriptRoot "recover.ps1"
$ReadinessScript = Join-Path $PSScriptRoot "wait-core-readiness.ps1"
$ValidationLockPath = Join-Path $RuntimeRoot "validation.lock"
$StartLockPath = Join-Path $RuntimeRoot "start.lock"
$HeartbeatPath = Join-Path $RuntimeRoot "supervisor-heartbeat.json"
$WorkerHeartbeatDir = Join-Path $RuntimeRoot "worker-heartbeats"
$ProcessManagementScript = Join-Path $PSScriptRoot "process-management.ps1"
$RuntimeIntentScript = Join-Path $PSScriptRoot "runtime-intent.ps1"

. $ProcessManagementScript
. $RuntimeIntentScript

New-Item -ItemType Directory -Force -Path $RuntimeRoot, $LogDir | Out-Null

function Write-SupervisorLog([string]$Message) {
  if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -ge 5MB) {
    if (Test-Path -LiteralPath "$LogPath.4") { Remove-Item -LiteralPath "$LogPath.4" -Force }
    for ($index = 3; $index -ge 1; $index -= 1) {
      $source = "$LogPath.$index"
      if (Test-Path -LiteralPath $source) { Move-Item -LiteralPath $source -Destination "$LogPath.$($index + 1)" -Force }
    }
    Move-Item -LiteralPath $LogPath -Destination "$LogPath.1" -Force
  }
  $line = "{0} {1}{2}" -f (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK"), $Message, [Environment]::NewLine
  [IO.File]::AppendAllText($LogPath, $line, [Text.UTF8Encoding]::new($false))
}

function Write-SupervisorHeartbeat([string]$Phase = "monitoring") {
  $payload = [ordered]@{
    pid = $PID
    phase = $Phase
    checkedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($HeartbeatPath, $payload, [Text.UTF8Encoding]::new($false))
}

function Stop-RecoveryProcessTree([int]$RootProcessId) {
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $order = [System.Collections.Generic.List[int]]::new()
  function Add-Descendants([int]$ProcessId) {
    $parent = $all | Where-Object { $_.ProcessId -eq $ProcessId } | Select-Object -First 1
    if (!$parent) { return }
    foreach ($child in $all | Where-Object { $_.ParentProcessId -eq $ProcessId }) {
      if (Test-AmbParentChildLink -Parent $parent -Child $child) {
        Add-Descendants ([int]$child.ProcessId)
      }
    }
    $order.Add($ProcessId)
  }
  Add-Descendants $RootProcessId
  foreach ($processId in $order) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
}

function Wait-RecoveryProcess(
  [System.Diagnostics.Process]$Process,
  [int]$TimeoutSeconds,
  [string]$Phase
) {
  $deadline = (Get-Date).AddSeconds([Math]::Max(10, $TimeoutSeconds))
  while (!$Process.HasExited -and (Get-Date) -lt $deadline) {
    Write-SupervisorHeartbeat $Phase
    [void]$Process.WaitForExit(5000)
    $Process.Refresh()
  }
  if (!$Process.HasExited) {
    Stop-RecoveryProcessTree $Process.Id
    throw "$Phase timed out after $TimeoutSeconds seconds"
  }
  [void]$Process.WaitForExit()
  $Process.Refresh()
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

function Get-MissingServiceNames {
  $missing = [System.Collections.Generic.List[string]]::new()
  foreach ($name in @("api", "worker-hot-a", "worker-hot-b", "worker-background", "dashboard")) {
    $pidPath = Join-Path $PidDir "$name.pid"
    $recordedPid = 0
    $value = if (Test-Path -LiteralPath $pidPath) {
      Get-Content -LiteralPath $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1
    } else {
      $null
    }
    if (!$value -or ![int]::TryParse($value, [ref]$recordedPid) -or $recordedPid -le 0) {
      $missing.Add($name)
      continue
    }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $recordedPid" -ErrorAction SilentlyContinue
    if (!$process -or !(Test-AmbOwnedServiceProcess -Process $process -ProjectRoot $ProjectRoot -ServiceName $name)) {
      $missing.Add($name)
    }
  }
  return $missing
}

function Convert-HeartbeatToUtc($Value) {
  if ($Value -is [datetime]) { return ([datetime]$Value).ToUniversalTime() }
  return [datetimeoffset]::Parse(
    [string]$Value,
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind
  ).UtcDateTime
}

function Get-StaleWorkerServiceNames {
  $stale = [System.Collections.Generic.List[string]]::new()
  foreach ($worker in @(
      @{ Service = "worker-hot-a"; File = "hot-a.json" },
      @{ Service = "worker-hot-b"; File = "hot-b.json" },
      @{ Service = "worker-background"; File = "background.json" }
    )) {
    $serviceName = $worker.Service
    $heartbeatFile = Join-Path $WorkerHeartbeatDir $worker.File
    if (!(Test-Path -LiteralPath $heartbeatFile)) {
      $stale.Add($serviceName)
      continue
    }
    try {
      $heartbeat = Get-Content -LiteralPath $heartbeatFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $checkedAtUtc = Convert-HeartbeatToUtc $heartbeat.checkedAt
      $heartbeatPid = 0
      $recordedPid = 0
      $pidPath = Join-Path $PidDir "$serviceName.pid"
      $pidValue = Get-Content -LiteralPath $pidPath -ErrorAction Stop | Select-Object -First 1
      $pidMatches = [int]::TryParse([string]$heartbeat.pid, [ref]$heartbeatPid) -and
        [int]::TryParse([string]$pidValue, [ref]$recordedPid) -and
        $heartbeatPid -eq $recordedPid -and $recordedPid -gt 0
      if (!$pidMatches -or $checkedAtUtc -lt [datetime]::UtcNow.AddSeconds(-[Math]::Max(15, $WorkerHeartbeatStaleSeconds))) {
        $stale.Add($serviceName)
      }
    } catch {
      $stale.Add($serviceName)
    }
  }
  # The replica heartbeats prove both processes are alive. The generic hot
  # heartbeat proves that one of them actually owns the Redis leader lease and
  # has active BullMQ consumers. If election is stuck beyond the lease window,
  # restart only the hot pair and leave API/background/dashboard untouched.
  $leaderHeartbeatFile = Join-Path $WorkerHeartbeatDir "hot.json"
  if (!(Test-Path -LiteralPath $leaderHeartbeatFile)) {
    $stale.Add("worker-hot-a")
    $stale.Add("worker-hot-b")
  } else {
    try {
      $leaderHeartbeat = Get-Content -LiteralPath $leaderHeartbeatFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $leaderCheckedAtUtc = Convert-HeartbeatToUtc $leaderHeartbeat.checkedAt
      $replicaPids = @("worker-hot-a", "worker-hot-b") | ForEach-Object {
        Get-Content -LiteralPath (Join-Path $PidDir "$_.pid") -ErrorAction Stop | Select-Object -First 1
      }
      if ($leaderHeartbeat.leadership -ne "leader" -or
          [string]$leaderHeartbeat.pid -notin @($replicaPids | ForEach-Object { [string]$_ }) -or
          $leaderCheckedAtUtc -lt [datetime]::UtcNow.AddSeconds(-[Math]::Max(15, $WorkerHeartbeatStaleSeconds))) {
        $stale.Add("worker-hot-a")
        $stale.Add("worker-hot-b")
      }
    } catch {
      $stale.Add("worker-hot-a")
      $stale.Add("worker-hot-b")
    }
  }
  return @($stale | Select-Object -Unique)
}

function Test-LocalTcpPort([int]$Port, [int]$TimeoutMilliseconds = 500) {
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $connect = $client.ConnectAsync("127.0.0.1", $Port)
    return $connect.Wait([Math]::Max(100, $TimeoutMilliseconds)) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

$lock = $null
try {
  $lock = [IO.File]::Open($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch {
  Write-SupervisorLog "another supervisor is already active; duplicate trigger exited"
  exit 0
}

try {
  # The scheduled supervisor is the boot-time owner of the run request. A
  # manual local:stop still clears it for the remainder of this supervisor
  # session; the next Windows boot/task start activates monitoring again.
  Set-AmbRunIntent
  Write-SupervisorLog "supervisor started; automatic run request activated"
  $failures = 0
  $recoveryAttempt = 0
  $nextRecoveryAt = [datetime]::MinValue
  $idleLogged = $false
  while ($true) {
    if (!(Test-AmbRunIntent)) {
      Write-SupervisorHeartbeat "idle-after-manual-stop"
      if (!$idleLogged) {
        Write-SupervisorLog "automatic session is idle after a manual stop"
        $idleLogged = $true
      }
      $failures = 0
      $recoveryAttempt = 0
      $nextRecoveryAt = [datetime]::MinValue
      Start-Sleep -Seconds ([Math]::Max(1, $CheckIntervalSeconds))
      continue
    }
    if ($idleLogged) {
      Write-SupervisorLog "run request detected; monitoring enabled"
      $idleLogged = $false
    }
    Write-SupervisorHeartbeat "monitoring"
    if ((Test-LockHeld $ValidationLockPath) -or (Test-LockHeld $StartLockPath)) {
      $failures = 0
      Start-Sleep -Seconds ([Math]::Max(1, $CheckIntervalSeconds))
      continue
    }
    $missingServices = @(Get-MissingServiceNames)
    $staleWorkerServices = if ($missingServices.Count -eq 0) { @(Get-StaleWorkerServiceNames) } else { @() }
    if ($missingServices.Count -gt 0) {
      # A dead process is definitive and should not wait for two HTTP probes.
      $failures = [Math]::Max([Math]::Max(1, $ConsecutiveFailuresBeforeRestart), $failures + 1)
      Write-SupervisorLog "missing process detected: $($missingServices -join ', ')"
    } elseif ($staleWorkerServices.Count -gt 0) {
      # A stale role heartbeat identifies the exact blocked event loop. Restart
      # that worker only; never sacrifice realtime because background is busy.
      $failures = [Math]::Max([Math]::Max(1, $ConsecutiveFailuresBeforeRestart), $failures + 1)
      Write-SupervisorLog "stale worker heartbeat detected: $($staleWorkerServices -join ', ')"
    } else {
      & $ReadinessScript -TimeoutSeconds 3 -StableChecks 1 -SingleAttempt -Quiet
      if ($LASTEXITCODE -eq 0) {
        $failures = 0
        $recoveryAttempt = 0
        $nextRecoveryAt = [datetime]::MinValue
      } else {
        $failures += 1
        Write-SupervisorLog "readiness failure $failures/$ConsecutiveReadinessFailuresBeforeRecovery"
      }
    }
    if ($missingServices.Count -eq 0 -and $staleWorkerServices.Count -eq 0 -and $LASTEXITCODE -eq 0) {
      $failures = 0
      $recoveryAttempt = 0
      $nextRecoveryAt = [datetime]::MinValue
    } else {
      $requiredFailures = if ($missingServices.Count -gt 0 -or $staleWorkerServices.Count -gt 0) {
        [Math]::Max(1, $ConsecutiveFailuresBeforeRestart)
      } else {
        [Math]::Max(2, $ConsecutiveReadinessFailuresBeforeRecovery)
      }
      if ($failures -ge $requiredFailures -and (Get-Date) -ge $nextRecoveryAt) {
        try {
          $recoveryAttempt += 1
          Write-SupervisorLog "recovery attempt $recoveryAttempt started"
          $powershell = Join-Path $PSHOME "powershell.exe"
          $infrastructureReady = (Test-LocalTcpPort 55432) -and (Test-LocalTcpPort 6380)
          if ($missingServices.Count -eq 0 -and $staleWorkerServices.Count -eq 0 -and $infrastructureReady) {
            # All owned processes and both worker event loops are alive. A
            # transient/degraded /ready response is diagnostic, not proof that
            # restarting the complete stack will improve anything.
            Write-SupervisorLog "readiness remains degraded but processes, worker heartbeats, and infrastructure are alive; restart suppressed"
            $failures = 0
            $recoveryAttempt = 0
            $nextRecoveryAt = [datetime]::MinValue
            continue
          }
          $fastRecoveryReady = $false
          $fastRecoveryExitCode = $null
          if ($missingServices.Count -eq 5 -and !$infrastructureReady) {
            Write-SupervisorLog "cold start detected; skipping inapplicable fast recovery"
          } else {
            $fastRecoveryArguments = @(
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy", "Bypass",
              "-File", $FastRecoveryScript,
              "-TimeoutSeconds", "35"
            )
            if ($staleWorkerServices.Count -gt 0) {
              $fastRecoveryArguments += "-RestartServices"
              $fastRecoveryArguments += $staleWorkerServices
            }
            $fastRecovery = Start-Process -FilePath $powershell -WindowStyle Hidden -PassThru `
              -RedirectStandardOutput (Join-Path $LogDir "supervisor-fast-recovery.out.log") `
              -RedirectStandardError (Join-Path $LogDir "supervisor-fast-recovery.err.log") `
              -ArgumentList $fastRecoveryArguments
            Wait-RecoveryProcess -Process $fastRecovery -TimeoutSeconds 50 -Phase "fast-recovery"
            $fastRecoveryExitCode = $fastRecovery.ExitCode
            & $ReadinessScript -TimeoutSeconds 12 -StableChecks 2 -Quiet
            $fastRecoveryReady = $LASTEXITCODE -eq 0
          }
          if ($fastRecoveryReady) {
            Write-SupervisorLog "fast recovery completed"
          } else {
            Write-SupervisorLog "fast recovery was not applicable or failed (code $fastRecoveryExitCode); starting full recovery"
            $recovery = Start-Process -FilePath $powershell -WindowStyle Hidden -PassThru `
              -RedirectStandardOutput (Join-Path $LogDir "supervisor-recovery.out.log") `
              -RedirectStandardError (Join-Path $LogDir "supervisor-recovery.err.log") `
              -ArgumentList @(
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-File", $StartScript,
                "-FromSupervisor"
              )
            Wait-RecoveryProcess -Process $recovery -TimeoutSeconds 180 -Phase "full-recovery"
            $recoveryExitCode = $recovery.ExitCode
            & $ReadinessScript -TimeoutSeconds 75 -StableChecks 2 -Quiet
            if ($LASTEXITCODE -ne 0) { throw "start.ps1 exited without restoring core readiness (code $recoveryExitCode)" }
            Write-SupervisorLog "full recovery completed"
          }
          $failures = 0
          $recoveryAttempt = 0
          $nextRecoveryAt = [datetime]::MinValue
        } catch {
          Write-SupervisorLog "recovery failed: $($_.Exception.Message)"
          $backoffSeconds = @(15, 30, 60, 120, 300)[[Math]::Min([Math]::Max(0, $recoveryAttempt - 1), 4)]
          $nextRecoveryAt = (Get-Date).AddSeconds($backoffSeconds)
          Write-SupervisorLog "next recovery is allowed after $($nextRecoveryAt.ToString('o'))"
        }
      }
    }
    Start-Sleep -Seconds ([Math]::Max(1, $CheckIntervalSeconds))
  }
} finally {
  Write-SupervisorLog "supervisor stopped"
  Remove-Item -LiteralPath $HeartbeatPath -Force -ErrorAction SilentlyContinue
  if ($lock) { $lock.Dispose() }
}
