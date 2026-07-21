param(
  [string]$TaskName = "Auto Monitor Bot"
)

$ErrorActionPreference = "Stop"

$taskNames = @($TaskName, "$TaskName Watchdog", "$TaskName Database Backup")
foreach ($name in $taskNames) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (!$task) {
    Write-Host "Scheduled task not found: $name"
    continue
  }

  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  Write-Host "Removed scheduled task: $name"
}
