[CmdletBinding()]
param([switch]$Ci, [switch]$Fast)

if ($Ci -and $Fast) { throw "Fast validation cannot replace the CI/release gate" }

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RuntimeDir = Join-Path $ProjectRoot ".runtime"
$LockPath = Join-Path $RuntimeDir "validation.lock"
$LockStream = $null

function Invoke-Pnpm {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  $stepTimer = [Diagnostics.Stopwatch]::StartNew()
  & (Join-Path $ProjectRoot "amb.cmd") @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
  Write-Host ("Validation step {0}: {1:N1}s" -f ($Arguments -join ' '), $stepTimer.Elapsed.TotalSeconds)
}

New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
try {
  $LockStream = [IO.File]::Open($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch {
  throw "Another validation or build is already running ($LockPath)."
}

try {
  Push-Location $ProjectRoot
  try {
    if ($Ci) {
      if ($env:GITHUB_ACTIONS -ne "true") {
        throw "The -Ci validation mode is restricted to GitHub Actions"
      }
      Invoke-Pnpm -Arguments @("test:runtime-security")
    } else {
      Invoke-Pnpm -Arguments @("security:check")
    }
    Invoke-Pnpm -Arguments @("db:validate")
    Invoke-Pnpm -Arguments @("db:generate")
    Invoke-Pnpm -Arguments @("docs:check")
    Invoke-Pnpm -Arguments @("typecheck")
    Invoke-Pnpm -Arguments @("lint")
    if ($Fast) {
      Invoke-Pnpm -Arguments @("test")
      Write-Host "FAST check passed: all unit tests, schema, docs, typecheck and lint. Coverage, build and extended acceptance remain required for release."
      return
    }
    Invoke-Pnpm -Arguments @("test:powershell")
    Invoke-Pnpm -Arguments @("test:backup-crypto")
    Invoke-Pnpm -Arguments @("test:backup-health")
    Invoke-Pnpm -Arguments @("test:ci-policy")
    Invoke-Pnpm -Arguments @("test:coverage")
    & (Join-Path $PSScriptRoot "verify-production-build.ps1") -SkipLock
    if ($LASTEXITCODE -ne 0) {
      throw "Isolated production build failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
} finally {
  if ($LockStream) { $LockStream.Dispose() }
  Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
}
