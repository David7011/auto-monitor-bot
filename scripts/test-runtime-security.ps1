$ErrorActionPreference = "Stop"
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
. (Join-Path $PSScriptRoot "runtime-security.ps1")

function Get-ScheduledTask {
  param([string]$TaskName, [object]$ErrorAction)
  return $null
}

$missingFindings = @(Get-AmbTaskSecurityFindings `
  -ProjectRoot $ProjectRoot `
  -AllowedWriterSids @("S-1-5-18", "S-1-5-32-544"))
if ($missingFindings.Count -ne 4 -or @($missingFindings | Where-Object { $_ -match "required scheduled task is missing" }).Count -ne 4) {
  throw "Missing scheduled tasks were not reported fail-closed"
}

function Get-ScheduledTask {
  param([string]$TaskName, [object]$ErrorAction)
  throw [UnauthorizedAccessException]::new("test access denied")
}

$inaccessibleFindings = @(Get-AmbTaskSecurityFindings `
  -ProjectRoot $ProjectRoot `
  -AllowedWriterSids @("S-1-5-18", "S-1-5-32-544"))
if ($inaccessibleFindings.Count -ne 4 -or @($inaccessibleFindings | Where-Object { $_ -match "cannot be inspected" }).Count -ne 4) {
  throw "Inaccessible scheduled tasks were not reported fail-closed"
}

Write-Host "Runtime security regression tests passed: missing and inaccessible tasks fail closed"
