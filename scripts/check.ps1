[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RuntimeDir = Join-Path $ProjectRoot ".runtime"
$LockPath = Join-Path $RuntimeDir "validation.lock"
$LockStream = $null

function Invoke-Pnpm {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  & pnpm @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
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
    Invoke-Pnpm -Arguments @("db:validate")
    Invoke-Pnpm -Arguments @("db:generate")
    Invoke-Pnpm -Arguments @("typecheck")
    Invoke-Pnpm -Arguments @("lint")
    Invoke-Pnpm -Arguments @("test:powershell")
    Invoke-Pnpm -Arguments @("test")
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
