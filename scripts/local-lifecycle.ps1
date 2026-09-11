[CmdletBinding()]
param(
  [ValidateSet('start', 'stop', 'restart')][string]$Action = 'start',
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$systemTask = Get-ScheduledTask -TaskName 'Auto Monitor Bot' -ErrorAction SilentlyContinue

# SYSTEM processes hide their command lines from a normal user token. Treating
# that absence as "nothing to stop" created duplicate workers and port clashes.
# Use the normal Windows UAC path before changing runtime intent or PID files.
if ($systemTask -and !$isAdministrator) {
  if ($Elevated) { throw 'Windows did not grant the required process-control rights.' }
  Write-Host 'The project runs as SYSTEM. Windows elevation is required to control its processes.'
  $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  # Keep the elevated helper visible: this is an interactive lifecycle action
  # and the operator must be able to see both UAC and any startup failure.
  $process = Start-Process -FilePath $windowsPowerShell -Verb RunAs -WindowStyle Normal -PassThru -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-Action', $Action, '-Elevated'
  )
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw "Project $Action failed; see .runtime\logs\local-lifecycle.log" }
  Write-Host "Project $Action completed. Run .\amb.cmd local:status for the current health."
  exit 0
}

$env:PROJECT_ROOT = $ProjectRoot
$logPath = Join-Path $ProjectRoot '.runtime\logs\local-lifecycle.log'
New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null
try {
  "$(Get-Date -Format o) requested $Action" | Out-File -LiteralPath $logPath -Encoding utf8
  if ($Action -in @('stop', 'restart')) {
    if ($systemTask -and $systemTask.State -eq 'Running') {
      Stop-ScheduledTask -TaskName 'Auto Monitor Bot' -ErrorAction Stop
      $taskStopDeadline = (Get-Date).AddSeconds(15)
      do {
        Start-Sleep -Milliseconds 250
        $systemTask = Get-ScheduledTask -TaskName 'Auto Monitor Bot' -ErrorAction Stop
      } while ($systemTask.State -eq 'Running' -and (Get-Date) -lt $taskStopDeadline)
      if ($systemTask.State -eq 'Running') {
        throw 'SYSTEM supervisor did not stop within 15 seconds.'
      }
    }
    & (Join-Path $PSScriptRoot 'stop.ps1') 2>&1 | Tee-Object -FilePath $logPath -Append
  }
  if ($Action -in @('start', 'restart')) {
    & (Join-Path $PSScriptRoot 'start.ps1') 2>&1 | Tee-Object -FilePath $logPath -Append
    if ($LASTEXITCODE -ne 0) { throw 'Startup readiness failed' }
  }
  exit 0
} catch {
  $_ | Out-String | Out-File -LiteralPath $logPath -Append -Encoding utf8
  Write-Error $_ -ErrorAction Continue
  exit 1
}
