[CmdletBinding()]
param(
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$PidDir = Join-Path $ProjectRoot ".runtime\pids"
$ProcessManagementScript = Join-Path $PSScriptRoot "process-management.ps1"
$ReadinessScript = Join-Path $PSScriptRoot "wait-core-readiness.ps1"
. $ProcessManagementScript

$task = Get-ScheduledTask -TaskName "Auto Monitor Bot" -ErrorAction Stop
if ($task.State -ne "Running") { throw "The Auto Monitor Bot supervisor task is not running" }
$pidPath = Join-Path $PidDir "api.pid"
$oldPid = 0
$value = Get-Content -LiteralPath $pidPath -ErrorAction Stop | Select-Object -First 1
if (![int]::TryParse($value, [ref]$oldPid) -or $oldPid -le 0) { throw "The API PID file is invalid" }
$oldProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $oldPid" -ErrorAction Stop
if (!(Test-AmbOwnedProcess -Process $oldProcess -ProjectRoot $ProjectRoot)) {
  throw "Refusing to stop PID $oldPid because it is not owned by this project"
}

$startedAt = Get-Date
Stop-Process -Id $oldPid -Force
$deadline = $startedAt.AddSeconds([Math]::Max(30, $TimeoutSeconds))
$newPid = 0
do {
  Start-Sleep -Seconds 2
  $candidate = 0
  $candidateValue = Get-Content -LiteralPath $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($candidateValue -and [int]::TryParse($candidateValue, [ref]$candidate) -and $candidate -gt 0 -and $candidate -ne $oldPid) {
    $candidateProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $candidate" -ErrorAction SilentlyContinue
    if ($candidateProcess -and (Test-AmbOwnedProcess -Process $candidateProcess -ProjectRoot $ProjectRoot)) {
      $newPid = $candidate
      & $ReadinessScript -TimeoutSeconds 8 -StableChecks 1 -Quiet
      if ($LASTEXITCODE -eq 0) { break }
    }
  }
} while ((Get-Date) -lt $deadline)

if ($newPid -le 0 -or $LASTEXITCODE -ne 0) {
  throw "Supervisor did not recover the API within $TimeoutSeconds seconds"
}
$duration = [Math]::Round(((Get-Date) - $startedAt).TotalSeconds, 2)
Write-Host "Supervisor recovery test passed: API PID $oldPid -> $newPid in $duration seconds."
