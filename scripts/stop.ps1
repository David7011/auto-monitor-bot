param(
  [switch]$All
)

$ErrorActionPreference = "Stop"
$ProjectRoot = if ($env:PROJECT_ROOT) { (Resolve-Path $env:PROJECT_ROOT).Path } else { (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$ProjectRootMsys = "/cygdrive/" + (Split-Path -Qualifier $ProjectRoot).TrimEnd(":").ToLowerInvariant() + "/" + ($ProjectRoot.Substring(3).Replace("\", "/"))
$PidDir = Join-Path $ProjectRoot ".runtime\pids"
$ProcessManagementScript = Join-Path $PSScriptRoot "process-management.ps1"
$RuntimeIntentScript = Join-Path $PSScriptRoot "runtime-intent.ps1"
. $ProcessManagementScript
. $RuntimeIntentScript

Clear-AmbRunIntent

function Resolve-PostgresCtl {
  if ($env:POSTGRES_BIN) {
    if ((Split-Path -Leaf $env:POSTGRES_BIN) -ieq "pg_ctl.exe") { return $env:POSTGRES_BIN }
    return Join-Path $env:POSTGRES_BIN "pg_ctl.exe"
  }

  $candidates = @(
    (Join-Path $ProjectRoot ".runtime\postgresql\bin\pg_ctl.exe"),
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

Stop-AmbAppProcesses -ProjectRoot $ProjectRoot -PidDir $PidDir

if ($All) {
  $pgCtl = Resolve-PostgresCtl
  $pgData = if ($env:POSTGRES_DATA) { $env:POSTGRES_DATA } else { Join-Path $ProjectRoot ".runtime\pgdata" }
  if ((Test-Path $pgCtl) -and (Test-Path $pgData)) {
    & $pgCtl stop -D $pgData -m fast | Out-Null
    Write-Host "Stopped PostgreSQL"
  }

  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "redis-server.exe" -and ($_.CommandLine -like "*$ProjectRoot*" -or $_.CommandLine -like "*$ProjectRootMsys*")
  } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped Redis process $($_.ProcessId)"
  }
}
