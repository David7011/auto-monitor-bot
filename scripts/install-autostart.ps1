param(
  [string]$TaskName = "Auto Monitor Bot",
  [switch]$StartupOnly,
  [switch]$LogonOnly
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$StartScript = Join-Path $ProjectRoot "scripts\start.ps1"
$AutostartScript = Join-Path $ProjectRoot "scripts\autostart-run.ps1"
$AutostartLauncher = Join-Path $ProjectRoot "scripts\autostart-run.cmd"
$SupervisorScript = Join-Path $ProjectRoot "scripts\supervisor.ps1"
$SupervisorLauncher = Join-Path $ProjectRoot "scripts\supervisor.cmd"
$WatchdogScript = Join-Path $ProjectRoot "scripts\watchdog.ps1"
$WatchdogAlertPolicy = Join-Path $ProjectRoot "scripts\watchdog-alert-policy.ps1"
$WatchdogLauncher = Join-Path $ProjectRoot "scripts\watchdog.cmd"
$WatchdogTaskName = "$TaskName Watchdog"
$BackupLauncher = Join-Path $ProjectRoot "scripts\backup-database.cmd"
$BackupTaskName = "$TaskName Database Backup"
$RestoreDrillLauncher = Join-Path $ProjectRoot "scripts\test-database-restore.cmd"
$RestoreDrillTaskName = "$TaskName Database Restore Drill"
$LogDir = Join-Path $ProjectRoot ".runtime\logs"
$SecurityCheckScript = Join-Path $ProjectRoot "scripts\assert-runtime-security.ps1"
$SecurityCheckLauncher = Join-Path $ProjectRoot "scripts\security-check.cmd"

if (!(Test-Path $StartScript)) {
  throw "Start script not found: $StartScript"
}
if (!(Test-Path $AutostartScript)) {
  throw "Autostart wrapper not found: $AutostartScript"
}
if (!(Test-Path $AutostartLauncher)) {
  throw "Autostart launcher not found: $AutostartLauncher"
}
if (!(Test-Path $SupervisorScript)) {
  throw "Supervisor script not found: $SupervisorScript"
}
if (!(Test-Path $SupervisorLauncher)) {
  throw "Supervisor launcher not found: $SupervisorLauncher"
}
if (!(Test-Path $WatchdogScript)) {
  throw "Watchdog script not found: $WatchdogScript"
}
if (!(Test-Path $WatchdogAlertPolicy)) {
  throw "Watchdog alert policy not found: $WatchdogAlertPolicy"
}
if (!(Test-Path $WatchdogLauncher)) {
  throw "Watchdog launcher not found: $WatchdogLauncher"
}
if (!(Test-Path $BackupLauncher)) {
  throw "Database backup launcher not found: $BackupLauncher"
}
if (!(Test-Path $RestoreDrillLauncher)) {
  throw "Database restore-drill launcher not found: $RestoreDrillLauncher"
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Assert-SecureProjectAcl {
  if (!(Test-Path -LiteralPath $SecurityCheckScript -PathType Leaf)) {
    throw "Runtime security check is missing: $SecurityCheckScript"
  }
  & $SecurityCheckLauncher -ProjectRoot $ProjectRoot -Quiet -SkipScheduledTasks
  if ($LASTEXITCODE -ne 0) {
    throw "Project ACL is not safe for SYSTEM tasks. Run '.\amb.cmd security:harden' from an elevated shell first."
  }
}

Assert-SecureProjectAcl
$action = New-ScheduledTaskAction `
  -Execute "$env:SystemRoot\System32\cmd.exe" `
  -Argument "/d /s /c `"`"$SupervisorLauncher`"`"" `
  -WorkingDirectory $ProjectRoot

$triggers = @()
if ($LogonOnly) {
  $triggers += New-ScheduledTaskTrigger -AtLogOn
} elseif ($StartupOnly) {
  $triggers += New-ScheduledTaskTrigger -AtStartup
} else {
  $triggers += New-ScheduledTaskTrigger -AtStartup
  $triggers += New-ScheduledTaskTrigger -AtLogOn
}

$principal = New-ScheduledTaskPrincipal `
  -UserId "SYSTEM" `
  -LogonType ServiceAccount `
  -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable

try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $triggers `
    -Principal $principal `
    -Settings $settings `
    -Description "Starts Auto Monitor Bot at Windows boot/logon and continuously supervises its API, isolated hot/background workers, and dashboard." `
    -Force | Out-Null

  $restoreDrillAction = New-ScheduledTaskAction `
    -Execute "$env:SystemRoot\System32\cmd.exe" `
    -Argument "/d /s /c `"`"$RestoreDrillLauncher`"`"" `
    -WorkingDirectory $ProjectRoot
  $restoreDrillTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "04:00"
  Register-ScheduledTask `
    -TaskName $RestoreDrillTaskName `
    -Action $restoreDrillAction `
    -Trigger $restoreDrillTrigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Restores the newest encrypted backup into an isolated temporary database and validates it weekly." `
    -Force | Out-Null

  $backupAction = New-ScheduledTaskAction `
    -Execute "$env:SystemRoot\System32\cmd.exe" `
    -Argument "/d /s /c `"`"$BackupLauncher`"`"" `
    -WorkingDirectory $ProjectRoot
  $backupTrigger = New-ScheduledTaskTrigger -Daily -At "03:15"
  Register-ScheduledTask `
    -TaskName $BackupTaskName `
    -Action $backupAction `
    -Trigger $backupTrigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Creates and validates a daily encrypted PostgreSQL backup for Auto Monitor Bot." `
    -Force | Out-Null

  $watchdogAction = New-ScheduledTaskAction `
    -Execute "$env:SystemRoot\System32\cmd.exe" `
    -Argument "/d /s /c `"`"$WatchdogLauncher`"`"" `
    -WorkingDirectory $ProjectRoot
  $watchdogTrigger = New-ScheduledTaskTrigger `
    -Once `
    -At ((Get-Date).AddMinutes(1)) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

  Register-ScheduledTask `
    -TaskName $WatchdogTaskName `
    -Action $watchdogAction `
    -Trigger $watchdogTrigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Checks and recovers an automatically started Auto Monitor Bot session while its run request is active." `
    -Force | Out-Null
} catch {
  throw "Failed to install the SYSTEM startup task. Run this script from an elevated PowerShell window. Original error: $($_.Exception.Message)"
}

Write-Host "Installed scheduled task: $TaskName"
Write-Host "Installed scheduled task: $WatchdogTaskName"
Write-Host "Installed scheduled task: $BackupTaskName"
Write-Host "Installed scheduled task: $RestoreDrillTaskName"
$triggerMode = if ($LogonOnly) {
  "any-user logon trigger"
} elseif ($StartupOnly) {
  "Windows startup trigger"
} else {
  "Windows startup and any-user logon triggers"
}
Write-Host "Mode: SYSTEM account, $triggerMode"
