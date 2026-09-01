[CmdletBinding()]
param(
  [int]$FailoverTimeoutSeconds = 15,
  [int]$RedundancyRecoveryTimeoutSeconds = 45
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$RuntimeRoot = Join-Path $ProjectRoot ".runtime"
$PidDir = Join-Path $RuntimeRoot "pids"
$ValidationLockPath = Join-Path $RuntimeRoot "validation.lock"
$EvidenceDir = Join-Path $RuntimeRoot "acceptance"
$EvidencePath = Join-Path $EvidenceDir "hot-worker-failover.json"
$ProcessManagementScript = Join-Path $PSScriptRoot "process-management.ps1"
. $ProcessManagementScript

function Get-Health {
  return Invoke-RestMethod -Uri "http://127.0.0.1:4000/health" -TimeoutSec 5
}

function Get-OwnedServicePid([string]$Name) {
  $pidPath = Join-Path $PidDir "$Name.pid"
  $parsedPid = 0
  $value = Get-Content -LiteralPath $pidPath -ErrorAction Stop | Select-Object -First 1
  if (![int]::TryParse([string]$value, [ref]$parsedPid) -or $parsedPid -le 0) {
    throw "Invalid PID file for $Name"
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $parsedPid" -ErrorAction SilentlyContinue
  if (!$process -or !(Test-AmbOwnedServiceProcess -Process $process -ProjectRoot $ProjectRoot -ServiceName $Name)) {
    throw "PID $parsedPid is not an owned $Name process"
  }
  return $parsedPid
}

function Wait-Until([scriptblock]$Condition, [datetime]$Deadline, [int]$PollMilliseconds = 250) {
  do {
    try {
      $value = & $Condition
      if ($null -ne $value -and $value -ne $false) { return $value }
    } catch {
      # Transient API/process state is expected during forced failover.
    }
    Start-Sleep -Milliseconds $PollMilliseconds
  } while ((Get-Date) -lt $Deadline)
  return $null
}

$validationLock = $null
$killedService = $null
$killedPid = 0
try {
  $task = Get-ScheduledTask -TaskName "Auto Monitor Bot" -ErrorAction Stop
  if ($task.State -ne "Running") { throw "Auto Monitor Bot supervisor task is not running" }

  $before = Get-Health
  if ($before.monitoring.status -ne "STOPPED") {
    throw "Safety gate: live failover test requires monitoring.status=STOPPED"
  }
  if ($before.workers.hotRedundancy.status -ne "REDUNDANT") {
    throw "Safety gate: both hot replicas and a consistent leader are required before the test"
  }
  $beforePids = [ordered]@{}
  foreach ($serviceName in @("api", "worker-hot-a", "worker-hot-b", "worker-background", "dashboard")) {
    $beforePids[$serviceName] = Get-OwnedServicePid $serviceName
  }

  $leaderInstance = [string]$before.workers.roles.hot.instanceId
  if ($leaderInstance -notin @("a", "b")) { throw "Health endpoint did not identify the hot leader" }
  $killedService = "worker-hot-$leaderInstance"
  $killedPid = [int]$beforePids[$killedService]
  if ([int]$before.workers.roles.hot.pid -ne $killedPid) {
    throw "Health leader PID does not match the owned service PID"
  }

  # The supervisor intentionally skips recovery while this lock is held. This
  # isolates Redis lease failover from process restart, proving that the standby
  # itself takes over. The lock is always released in finally.
  $validationLock = [IO.File]::Open(
    $ValidationLockPath,
    [IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite,
    [IO.FileShare]::None
  )
  Start-Sleep -Seconds 1

  $startedAt = Get-Date
  Stop-Process -Id $killedPid -Force -ErrorAction Stop
  $promoted = Wait-Until -Deadline $startedAt.AddSeconds([Math]::Max(8, $FailoverTimeoutSeconds)) -Condition {
    $health = Get-Health
    if ($health.workers.hotRedundancy.leaderConsistent -and
        [int]$health.workers.roles.hot.pid -gt 0 -and
        [int]$health.workers.roles.hot.pid -ne $killedPid -and
        [string]$health.workers.roles.hot.instanceId -ne $leaderInstance) {
      return $health
    }
    return $null
  }
  if (!$promoted) { throw "Standby hot worker did not acquire leadership within $FailoverTimeoutSeconds seconds" }
  $failoverMs = [Math]::Round(((Get-Date) - $startedAt).TotalMilliseconds)

  $validationLock.Dispose()
  $validationLock = $null

  $recoveryStartedAt = Get-Date
  $restored = Wait-Until -Deadline $recoveryStartedAt.AddSeconds([Math]::Max(15, $RedundancyRecoveryTimeoutSeconds)) -PollMilliseconds 500 -Condition {
    $health = Get-Health
    $replacementPid = Get-OwnedServicePid $killedService
    if ($replacementPid -ne $killedPid -and $health.workers.hotRedundancy.status -eq "REDUNDANT") {
      return @{ Health = $health; ReplacementPid = $replacementPid }
    }
    return $null
  }
  if (!$restored) {
    throw "Supervisor did not restore the killed replica and REDUNDANT state within $RedundancyRecoveryTimeoutSeconds seconds"
  }

  $after = Get-Health
  if ($after.monitoring.status -ne "STOPPED") { throw "Monitoring state changed during the failover test" }
  $preservedServices = @("api", "worker-background", "dashboard", "worker-hot-$($promoted.workers.roles.hot.instanceId)")
  foreach ($serviceName in $preservedServices) {
    $currentPid = Get-OwnedServicePid $serviceName
    if ($currentPid -ne [int]$beforePids[$serviceName]) {
      throw "Failover restarted healthy $serviceName ($($beforePids[$serviceName]) -> $currentPid)"
    }
  }
  $evidence = [ordered]@{
    checkedAt = (Get-Date).ToString("o")
    monitoringStatus = [string]$after.monitoring.status
    killedService = $killedService
    killedPid = $killedPid
    promotedInstance = [string]$promoted.workers.roles.hot.instanceId
    promotedPid = [int]$promoted.workers.roles.hot.pid
    failoverMs = $failoverMs
    replacementPid = [int]$restored.ReplacementPid
    redundancyRecoveryMs = [Math]::Round(((Get-Date) - $recoveryStartedAt).TotalMilliseconds)
    finalRedundancy = [string]$after.workers.hotRedundancy.status
    finalLeaderConsistent = [bool]$after.workers.hotRedundancy.leaderConsistent
    preservedPids = [ordered]@{
      api = [int]$beforePids["api"]
      promotedReplica = [int]$beforePids["worker-hot-$($promoted.workers.roles.hot.instanceId)"]
      background = [int]$beforePids["worker-background"]
      dashboard = [int]$beforePids["dashboard"]
    }
  }
  New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
  [IO.File]::WriteAllText(
    $EvidencePath,
    ($evidence | ConvertTo-Json -Depth 5),
    [Text.UTF8Encoding]::new($false)
  )
  Write-Host "Hot-worker failover passed: $killedService PID $killedPid -> leader $($evidence.promotedInstance) PID $($evidence.promotedPid) in $failoverMs ms; redundancy restored with PID $($evidence.replacementPid)."
  Write-Host "Evidence: $EvidencePath"
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
} finally {
  if ($validationLock) { $validationLock.Dispose() }
}
