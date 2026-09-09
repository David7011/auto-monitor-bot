[CmdletBinding()]
param([int]$TimeoutSeconds = 300)

$ErrorActionPreference = "Stop"
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$LogRoot = Join-Path $ProjectRoot ".runtime\logs"
$ResultPath = Join-Path $LogRoot "autostart-runtime-test.json"
[IO.Directory]::CreateDirectory($LogRoot) | Out-Null

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "SYSTEM task runtime test requires an elevated Administrator shell"
}

function Invoke-AndWaitScheduledTask {
  param([Parameter(Mandatory = $true)][string]$TaskName)

  $before = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
  Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 500
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
    $newRunObserved = $info.LastRunTime -gt $before.LastRunTime
  } while ((!$newRunObserved -or $task.State -eq "Running") -and (Get-Date) -lt $deadline)

  if (!$newRunObserved -or $task.State -eq "Running") {
    throw "Scheduled task '$TaskName' did not complete within $TimeoutSeconds seconds"
  }
  if ([int64]$info.LastTaskResult -ne 0) {
    throw "Scheduled task '$TaskName' failed with result $($info.LastTaskResult)"
  }
  return [pscustomobject]@{
    taskName = $TaskName
    state = [string]$task.State
    lastRunTime = $info.LastRunTime.ToString("o")
    lastTaskResult = [int64]$info.LastTaskResult
  }
}

$supervisor = Get-ScheduledTask -TaskName "Auto Monitor Bot" -ErrorAction Stop
if ($supervisor.State -ne "Running") { throw "The SYSTEM supervisor task is not running" }
$heartbeatPath = Join-Path $ProjectRoot ".runtime\supervisor-heartbeat.json"
$heartbeat = Get-Content -LiteralPath $heartbeatPath -Raw -Encoding UTF8 | ConvertFrom-Json
$heartbeatAge = ((Get-Date) - [datetime]$heartbeat.checkedAt).TotalSeconds
if ($heartbeatAge -gt 30) { throw "The supervisor heartbeat is stale" }

$results = @(
  Invoke-AndWaitScheduledTask -TaskName "Auto Monitor Bot Watchdog"
  Invoke-AndWaitScheduledTask -TaskName "Auto Monitor Bot Database Backup"
  Invoke-AndWaitScheduledTask -TaskName "Auto Monitor Bot Database Restore Drill"
)

@{
  testedAt = (Get-Date).ToString("o")
  supervisorState = [string]$supervisor.State
  supervisorHeartbeatAgeSeconds = [Math]::Round($heartbeatAge, 2)
  tasks = $results
  result = "PASS"
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ResultPath -Encoding UTF8

Write-Host "SYSTEM task runtime test passed: supervisor, watchdog, backup, and restore drill are operational"
