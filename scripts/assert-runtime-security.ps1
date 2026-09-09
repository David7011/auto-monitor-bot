[CmdletBinding()]
param(
  [string]$ProjectRoot,
  [switch]$Quiet,
  [switch]$SkipScheduledTasks
)

$ErrorActionPreference = "Stop"
if (!$ProjectRoot) { $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
. (Join-Path $PSScriptRoot "runtime-security.ps1")

try {
  $result = Test-AmbRuntimeSecurity -ProjectRoot $ProjectRoot -SkipScheduledTasks:$SkipScheduledTasks
  if (!$result.Secure) {
    foreach ($finding in $result.Findings) { Write-Error "Runtime security check failed: $finding" -ErrorAction Continue }
    exit 1
  }
  if (!$Quiet) {
    Write-Host "Runtime security check passed: protected runtime ACLs and all required SYSTEM task definitions were verified."
  }
  exit 0
} catch {
  Write-Error "Runtime security check failed closed: $($_.Exception.Message)"
  exit 1
}
