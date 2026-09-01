param(
  [switch]$Install
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RuntimeRoot = Join-Path $ProjectRoot ".runtime"
$BrowserRoot = Join-Path $RuntimeRoot "playwright-browsers"
$TempRoot = Join-Path $RuntimeRoot "playwright-temp"

New-Item -ItemType Directory -Force -Path $BrowserRoot, $TempRoot | Out-Null
$env:PLAYWRIGHT_BROWSERS_PATH = $BrowserRoot
$env:TEMP = $TempRoot
$env:TMP = $TempRoot
if (!$env:E2E_BASE_URL) { $env:E2E_BASE_URL = "http://127.0.0.1:3101" }

Set-Location $ProjectRoot
if ($Install) {
  & pnpm exec playwright install chromium
} else {
  $temporaryUsername = $null
  if (!$env:E2E_DASHBOARD_USERNAME -or !$env:E2E_DASHBOARD_PASSWORD) {
    $temporaryUsername = "e2e-$([guid]::NewGuid().ToString('N'))"
    $passwordBytes = [byte[]]::new(32)
    $passwordGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $passwordGenerator.GetBytes($passwordBytes) } finally { $passwordGenerator.Dispose() }
    $env:DASHBOARD_SEED_USERNAME = $temporaryUsername
    $env:DASHBOARD_SEED_PASSWORD = [Convert]::ToBase64String($passwordBytes)
    $env:E2E_DASHBOARD_USERNAME = $temporaryUsername
    $env:E2E_DASHBOARD_PASSWORD = $env:DASHBOARD_SEED_PASSWORD
    & pnpm auth:seed | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to create temporary dashboard E2E user" }
  }

  $playwrightExitCode = 0
  try {
    & pnpm exec playwright test
    $playwrightExitCode = $LASTEXITCODE
  } finally {
    if ($temporaryUsername) {
      & node --conditions=production scripts/delete-dashboard-e2e-user.mjs $temporaryUsername | Out-Null
      if ($LASTEXITCODE -ne 0 -and $playwrightExitCode -eq 0) {
        $playwrightExitCode = $LASTEXITCODE
      }
    }
  }
  if ($playwrightExitCode -ne 0) { exit $playwrightExitCode }
}

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
