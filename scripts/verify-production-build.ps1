[CmdletBinding()]
param(
  [switch]$SkipLock
)

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

function Remove-ValidationOutput {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { return }
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  if (-not $resolved.StartsWith($ProjectRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove validation output outside project root: $resolved"
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}

New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
if (-not $SkipLock) {
  try {
    $LockStream = [IO.File]::Open($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch {
    throw "Another validation or build is already running ($LockPath)."
  }
}

$validationDirs = @(
  (Join-Path $ProjectRoot "packages\shared\.dist-validation"),
  (Join-Path $ProjectRoot "packages\db\.dist-validation"),
  (Join-Path $ProjectRoot "apps\api\.dist-validation"),
  (Join-Path $ProjectRoot "apps\worker\.dist-validation"),
  (Join-Path $ProjectRoot "apps\dashboard\.next-validation")
)

try {
  foreach ($directory in $validationDirs) { Remove-ValidationOutput -Path $directory }

  Write-Host "Building TypeScript services into isolated validation directories..." -ForegroundColor Cyan
  Invoke-Pnpm -Arguments @("--filter", "@amb/shared", "exec", "tsc", "-p", "tsconfig.build.json", "--outDir", ".dist-validation")
  Invoke-Pnpm -Arguments @("--filter", "@amb/db", "exec", "tsc", "-p", "tsconfig.build.json", "--outDir", ".dist-validation")
  Invoke-Pnpm -Arguments @("--filter", "@amb/api", "exec", "tsc", "-p", "tsconfig.build.json", "--outDir", ".dist-validation")
  Invoke-Pnpm -Arguments @("--filter", "@amb/worker", "exec", "tsc", "-p", "tsconfig.build.json", "--outDir", ".dist-validation")

  Write-Host "Building dashboard into isolated validation directory..." -ForegroundColor Cyan
  $previousDistDir = $env:NEXT_DIST_DIR
  $previousTsconfigPath = $env:NEXT_TSCONFIG_PATH
  $env:NEXT_DIST_DIR = ".next-validation"
  $env:NEXT_TSCONFIG_PATH = "tsconfig.validation.json"
  try {
    Invoke-Pnpm -Arguments @("--filter", "@amb/dashboard", "build")
  } finally {
    $env:NEXT_DIST_DIR = $previousDistDir
    $env:NEXT_TSCONFIG_PATH = $previousTsconfigPath
  }

  $expectedArtifacts = @(
    (Join-Path $ProjectRoot "packages\shared\.dist-validation\index.js"),
    (Join-Path $ProjectRoot "packages\db\.dist-validation\index.js"),
    (Join-Path $ProjectRoot "apps\api\.dist-validation\server.js"),
    (Join-Path $ProjectRoot "apps\worker\.dist-validation\index.js"),
    (Join-Path $ProjectRoot "apps\dashboard\.next-validation\BUILD_ID")
  )
  foreach ($artifact in $expectedArtifacts) {
    if (-not (Test-Path -LiteralPath $artifact)) {
      throw "Isolated build did not create expected artifact: $artifact"
    }
  }

  Write-Host "Isolated production build passed; live artifacts were not modified." -ForegroundColor Green
} finally {
  foreach ($directory in $validationDirs) { Remove-ValidationOutput -Path $directory }
  if ($LockStream) {
    $LockStream.Dispose()
    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
  }
}
