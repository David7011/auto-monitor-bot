$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$failed = $false

Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "scripts") -Filter "*.ps1" -File | ForEach-Object {
  $tokens = $null
  $errors = $null
  [Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count -gt 0) {
    $failed = $true
    Write-Error "$($_.Name): $($errors.Message -join '; ')" -ErrorAction Continue
  }
}

if ($failed) { exit 1 }

$runtimeIntentTestRoot = Join-Path ([IO.Path]::GetTempPath()) ("amb-runtime-intent-" + [guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Force -Path $runtimeIntentTestRoot | Out-Null
  $ProjectRoot = $runtimeIntentTestRoot
  . (Join-Path $PSScriptRoot "runtime-intent.ps1")
  Set-AmbRunIntent
  if (!(Test-AmbRunIntent)) { throw "A current-boot run request was not recognized" }
  Clear-AmbRunIntent
  if (Test-AmbRunIntent) { throw "A cleared run request remained active" }
  $staleIntent = @{ requestedAt = [DateTime]::UtcNow.AddDays(-2).ToString("o"); requestedByPid = 1 } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($script:AmbRunIntentPath, $staleIntent, [Text.UTF8Encoding]::new($false))
  if (Test-AmbRunIntent) { throw "A pre-boot run request was incorrectly recognized" }
  Clear-AmbRunIntent
} finally {
  Remove-Item -LiteralPath $runtimeIntentTestRoot -Recurse -Force -ErrorAction SilentlyContinue
  $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

. (Join-Path $PSScriptRoot "process-management.ps1")
. (Join-Path $PSScriptRoot "watchdog-alert-policy.ps1")
$firstProtection = Get-AmbSourceProtectionSnapshot @(
  [pscustomobject]@{ source = "RST"; sourceStatus = "CAPTCHA_DETECTED"; pausedUntil = "2026-08-30T10:44:26.041Z" }
)
$movedProbe = Get-AmbSourceProtectionSnapshot @(
  [pscustomobject]@{ source = "RST"; sourceStatus = "CAPTCHA_DETECTED"; pausedUntil = "2026-08-31T10:44:26.041Z" }
)
if ($firstProtection.Key -ne "RST=CAPTCHA_DETECTED" -or $movedProbe.Key -ne $firstProtection.Key) {
  throw "Source-protection deduplication changed when only pausedUntil moved"
}
if ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-AmbWatchdogAlertText).ProbeAfter)) -ne
    "0YjRgtCw0YLQvdCw0Y8g0L/RgNC+0LLQtdGA0LrQsCDQv9C+0YHQu9C1") {
  throw "Watchdog UTF-8 alert text was not decoded correctly"
}
$legacyProtectionKey = "RST=CAPTCHA_DETECTED, broken probe text 2026-08-30T10:44:26.041Z"
if ((ConvertTo-AmbCanonicalSourceProtectionKey $legacyProtectionKey) -ne $firstProtection.Key) {
  throw "Legacy watchdog state was not canonicalized"
}
$currentParent = [pscustomobject]@{
  ProcessId = 700
  ParentProcessId = 1
  SessionId = 2
  CreationDate = [datetime]"2026-08-19T17:00:00Z"
}
$realChild = [pscustomobject]@{
  ProcessId = 701
  ParentProcessId = 700
  SessionId = 2
  CreationDate = [datetime]"2026-08-19T17:00:01Z"
}
$stalePidChild = [pscustomobject]@{
  ProcessId = 702
  ParentProcessId = 700
  SessionId = 2
  CreationDate = [datetime]"2026-08-19T12:00:00Z"
}
$otherSessionChild = [pscustomobject]@{
  ProcessId = 703
  ParentProcessId = 700
  SessionId = 3
  CreationDate = [datetime]"2026-08-19T17:00:01Z"
}
if (!(Test-AmbParentChildLink -Parent $currentParent -Child $realChild)) {
  throw "A real application child process was rejected"
}
if (Test-AmbParentChildLink -Parent $currentParent -Child $stalePidChild) {
  throw "A stale PID relationship was accepted"
}
if (Test-AmbParentChildLink -Parent $currentParent -Child $otherSessionChild) {
  throw "A cross-session process was accepted as an application child"
}

Write-Host "PowerShell syntax validation passed"
