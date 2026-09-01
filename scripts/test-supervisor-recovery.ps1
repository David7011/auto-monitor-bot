[CmdletBinding()]
param(
  [ValidateSet("api", "worker-hot-a", "worker-hot-b", "worker-background", "dashboard")]
  [string]$Service = "api",
  [int]$TimeoutSeconds = 60,
  [int]$MaxRecoverySeconds = 15,
  [switch]$All
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$PidDir = Join-Path $ProjectRoot ".runtime\pids"
$ProcessManagementScript = Join-Path $PSScriptRoot "process-management.ps1"
$ReadinessScript = Join-Path $PSScriptRoot "wait-core-readiness.ps1"
$SupervisorHeartbeatPath = Join-Path $ProjectRoot ".runtime\supervisor-heartbeat.json"
. $ProcessManagementScript

function Get-ValidOwnedPid([string]$Name) {
  $pidPath = Join-Path $PidDir "$Name.pid"
  $parsedPid = 0
  $value = Get-Content -LiteralPath $pidPath -ErrorAction Stop | Select-Object -First 1
  if (![int]::TryParse($value, [ref]$parsedPid) -or $parsedPid -le 0) {
    throw "The $Name PID file is invalid"
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $parsedPid" -ErrorAction SilentlyContinue
  if (!$process -or !(Test-AmbOwnedServiceProcess -Process $process -ProjectRoot $ProjectRoot -ServiceName $Name)) {
    throw "PID $parsedPid is not a running $Name process owned by this project"
  }
  return $parsedPid
}

function Wait-SupervisorSettled([datetime]$TestStartedAt, [int]$TimeoutSeconds = 35) {
  $deadline = (Get-Date).AddSeconds([Math]::Max(10, $TimeoutSeconds))
  do {
    Start-Sleep -Seconds 1
    try {
      $heartbeat = Get-Content -LiteralPath $SupervisorHeartbeatPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $checkedAt = [datetime]$heartbeat.checkedAt
      if ($heartbeat.phase -eq "monitoring" -and $checkedAt -ge $TestStartedAt) {
        & $ReadinessScript -TimeoutSeconds 8 -StableChecks 2 -Quiet
        if ($LASTEXITCODE -eq 0) { return }
      }
    } catch {
      # Recovery updates the heartbeat phase while a child process is running.
    }
  } while ((Get-Date) -lt $deadline)
  throw "Supervisor recovered the process but did not settle back into monitoring within $TimeoutSeconds seconds"
}

function Invoke-RecoveryTest([string]$TargetService) {
  $before = @{}
  foreach ($name in @("api", "worker-hot-a", "worker-hot-b", "worker-background", "dashboard")) {
    $before[$name] = Get-ValidOwnedPid $name
  }
  $targetPid = [int]$before[$TargetService]
  if ($targetPid -le 0) { throw "No validated PID was captured for $TargetService" }

  $startedAt = Get-Date
  Stop-Process -Id $targetPid -Force
  $deadline = $startedAt.AddSeconds([Math]::Max(30, $TimeoutSeconds))
  $newPid = 0
  $ready = $false
  do {
    Start-Sleep -Seconds 1
    try {
      $candidate = Get-ValidOwnedPid $TargetService
      if ($candidate -ne $before[$TargetService]) {
        $newPid = $candidate
        & $ReadinessScript -TimeoutSeconds 8 -StableChecks 1 -Quiet
        if ($LASTEXITCODE -eq 0) {
          $ready = $true
          break
        }
      }
    } catch {
      # A missing or stale PID is expected while the supervisor is recovering.
    }
  } while ((Get-Date) -lt $deadline)

  if (!$ready -or $newPid -le 0) {
    throw "Supervisor did not recover $TargetService within $TimeoutSeconds seconds"
  }

  $duration = [Math]::Round(((Get-Date) - $startedAt).TotalSeconds, 2)
  if ($duration -gt $MaxRecoverySeconds) {
    throw "$TargetService recovered in $duration seconds, exceeding the $MaxRecoverySeconds-second target"
  }
  # The endpoint can become ready before the supervisor has completed its own
  # stable-readiness checks. Returning earlier lets a following fault test
  # overlap the previous recovery and can falsely force a full restart.
  Wait-SupervisorSettled -TestStartedAt $startedAt

  foreach ($name in @("api", "worker-hot-a", "worker-hot-b", "worker-background", "dashboard")) {
    $currentPid = Get-ValidOwnedPid $name
    if ($name -eq $TargetService) {
      if ($currentPid -eq $before[$name]) { throw "$name was not restarted" }
    } elseif ($currentPid -ne $before[$name]) {
      throw "Targeted recovery restarted healthy $name process ($($before[$name]) -> $currentPid)"
    }
  }
  Write-Host "Supervisor recovery test passed: $TargetService PID $($before[$TargetService]) -> $newPid in $duration seconds; healthy processes were preserved."
}

$task = Get-ScheduledTask -TaskName "Auto Monitor Bot" -ErrorAction Stop
if ($task.State -ne "Running") { throw "The Auto Monitor Bot supervisor task is not running" }

$services = @($Service)
if ($All) { $services = @("api", "worker-hot-a", "worker-hot-b", "worker-background", "dashboard") }
for ($index = 0; $index -lt $services.Count; $index += 1) {
  Invoke-RecoveryTest $services[$index]
  if ($index -lt $services.Count - 1) { Start-Sleep -Seconds 10 }
}
