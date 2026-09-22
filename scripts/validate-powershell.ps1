$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$failed = $false

Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "scripts") -Filter "*.ps1" -File | ForEach-Object {
  if ($_.Name -eq "setup-new-pc.ps1" -and $_.Length -eq 0) {
    Write-Warning "Skipping the zero-byte Defender-blocked local bootstrap prototype; use prepare-new-pc.ps1"
    return
  }
  $tokens = $null
  $errors = $null
  [Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count -gt 0) {
    $failed = $true
    Write-Error "$($_.Name): $($errors.Message -join '; ')" -ErrorAction Continue
  }
}

if ($failed) { exit 1 }

$nodeRuntimeBootstrap = Get-Content -LiteralPath (Join-Path $PSScriptRoot "ensure-node-runtime.ps1") -Raw
if ($nodeRuntimeBootstrap -match '(?m)^\s*\(?\s*Get-FileHash\s') {
  throw "Pinned Node bootstrap must not depend on module-autoloaded Get-FileHash in minimal CI/service environments"
}
if ($nodeRuntimeBootstrap -notmatch '\[Security\.Cryptography\.SHA256\]::Create\(\)') {
  throw "Pinned Node bootstrap must verify downloads with the in-process SHA-256 implementation"
}

$backupScript = Get-Content -LiteralPath (Join-Path $PSScriptRoot "backup-database.ps1") -Raw
$backupHealthScript = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'backup-health.ps1') -Raw
if ($backupScript -notmatch 'Publish-AmbBackupMirror' -or
    $backupHealthScript -notmatch 'MIRROR_COPY_CHECKSUM_MISMATCH' -or
    $backupHealthScript -notmatch 'Publish the archive last') {
  throw "Backup mirror must verify the copied archive and publish it only after sidecars"
}
$restoreScript = Get-Content -LiteralPath (Join-Path $PSScriptRoot "test-database-restore.ps1") -Raw
if ($restoreScript -notmatch 'INDEPENDENT_MIRROR' -or $restoreScript -notmatch 'Configured backup mirror is unavailable') {
  throw "Scheduled restore drill must prefer and require a configured independent mirror"
}

$runtimeIntentTestRoot = Join-Path ([IO.Path]::GetTempPath()) ("amb-runtime-intent-" + [guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Force -Path $runtimeIntentTestRoot | Out-Null
  $ProjectRoot = $runtimeIntentTestRoot
  . (Join-Path $PSScriptRoot "runtime-intent.ps1")
  Set-AmbRunIntent
  if (!(Test-AmbRunIntent)) { throw "A current-boot run request was not recognized" }
  Clear-AmbRunIntent
  if (Test-AmbRunIntent) { throw "A cleared run request remained active" }
  # A fixed "now minus N days" is not guaranteed to predate boot on a
  # long-running production laptop. Anchor the fixture to the actual boot
  # boundary so this assertion remains deterministic regardless of uptime.
  $staleIntent = @{ requestedAt = (Get-AmbBootTimeUtc).AddMinutes(-1).ToString("o"); requestedByPid = 1 } | ConvertTo-Json -Compress
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

$releaseTestRoot = Join-Path ([IO.Path]::GetTempPath()) ("amb-release-" + [guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Force -Path $releaseTestRoot | Out-Null
  . (Join-Path $PSScriptRoot "accepted-release.ps1")
  $releaseId = "0123456789ab-20260922090000"
  $artifacts = foreach ($relativeRoot in $script:AmbReleaseArtifactRoots) {
    $active = Join-Path $releaseTestRoot (Join-Path $relativeRoot "fixture.bin")
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $active) | Out-Null
    [IO.File]::WriteAllText($active, "accepted:$relativeRoot", [Text.UTF8Encoding]::new($false))
    $relative = Get-AmbRelativePath $releaseTestRoot $active
    $snapshot = Join-Path (Join-Path $releaseTestRoot ".runtime\releases\$releaseId\artifacts") $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $snapshot) | Out-Null
    Copy-Item -LiteralPath $active -Destination $snapshot
    [ordered]@{
      path = $relative
      size = (Get-Item -LiteralPath $active).Length
      sha256 = Get-AmbFileSha256 $active
    }
  }
  $manifest = [ordered]@{
    format = "amb-accepted-release-v1"
    releaseId = $releaseId
    commit = "0123456789abcdef0123456789abcdef01234567"
    createdAt = "2026-09-22T09:00:00.000Z"
    runtimeVersion = "v24.18.0"
    schemaSha256 = ("0" * 64)
    migrationIds = @()
    artifactRoots = $script:AmbReleaseArtifactRoots
    artifacts = @($artifacts)
  }
  $manifestJson = $manifest | ConvertTo-Json -Depth 8
  $releaseManifest = Join-Path $releaseTestRoot ".runtime\releases\$releaseId\release-manifest.json"
  [IO.File]::WriteAllText($releaseManifest, $manifestJson, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $releaseTestRoot ".runtime\accepted-release.json"), $manifestJson, [Text.UTF8Encoding]::new($false))
  [void](Assert-AmbAcceptedRelease $releaseTestRoot "v24.18.0")
  $victim = Join-Path $releaseTestRoot "apps\api\dist\fixture.bin"
  [IO.File]::WriteAllText($victim, "corrupt", [Text.UTF8Encoding]::new($false))
  $checksumRejected = $false
  try { [void](Assert-AmbAcceptedRelease $releaseTestRoot "v24.18.0") } catch { $checksumRejected = $true }
  if (!$checksumRejected) { throw "Accepted release checksum mismatch was not rejected" }
  [void](Restore-AmbAcceptedRelease $releaseTestRoot $releaseId)
  [void](Assert-AmbAcceptedRelease $releaseTestRoot "v24.18.0")
} finally {
  if (Test-Path -LiteralPath $releaseTestRoot) { Remove-Item -LiteralPath $releaseTestRoot -Recurse -Force }
}

Write-Host "PowerShell syntax validation passed"
