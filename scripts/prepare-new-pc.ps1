[CmdletBinding()]
param(
  [string]$ProjectRoot,
  [string]$PostgresArchive,
  [switch]$WithDependencies,
  [switch]$WithRedis,
  [switch]$WithPostgres,
  [switch]$WithChecks
)

$ErrorActionPreference = "Stop"
if (!$ProjectRoot) { $ProjectRoot = Join-Path $PSScriptRoot ".." }
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
$Amb = Join-Path $ProjectRoot "amb.cmd"

function Assert-NativeSuccess([string]$Name) {
  if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE" }
}

if ($env:OS -ne "Windows_NT") { throw "This bootstrap supports Windows only" }
if (!(Test-Path -LiteralPath $Amb) -or !(Test-Path -LiteralPath (Join-Path $ProjectRoot "pnpm-lock.yaml"))) {
  throw "Project root is invalid: $ProjectRoot"
}

$driveName = [IO.Path]::GetPathRoot($ProjectRoot).TrimEnd(':','\')
$drive = Get-PSDrive -Name $driveName -ErrorAction Stop
if ($drive.Free -lt 5GB) { throw "At least 5 GB of free space is required" }

Write-Host "Preparing Auto Monitor Bot on this Windows computer"
Write-Host "Project: $ProjectRoot"
Write-Host "Production monitoring, secrets, database restore, and scheduled tasks are intentionally not changed."

& (Join-Path $ProjectRoot "scripts\ensure-node-runtime.ps1") -ProjectRoot $ProjectRoot | Out-Null
& $Amb --version
Assert-NativeSuccess "Pinned pnpm validation"

if ($WithPostgres) {
  $arguments = @()
  if ($PostgresArchive) { $arguments += @("-ArchivePath", [IO.Path]::GetFullPath($PostgresArchive)) }
  & (Join-Path $ProjectRoot "scripts\install-postgresql-windows.ps1") @arguments
}

if ($WithRedis) {
  & (Join-Path $ProjectRoot "scripts\install-redis-windows.ps1")
}

if ($WithDependencies) {
  Push-Location $ProjectRoot
  try {
    & $Amb install --frozen-lockfile
    Assert-NativeSuccess "Dependency installation"
  } finally { Pop-Location }
}

if ($WithChecks) {
  if (!(Test-Path -LiteralPath (Join-Path $ProjectRoot ".env"))) {
    throw ".env is missing. Restore it from the encrypted secrets archive first."
  }
  Push-Location $ProjectRoot
  try {
    & $Amb db:validate
    Assert-NativeSuccess "Database schema validation"
    & $Amb check
    Assert-NativeSuccess "Project validation"
  } finally { Pop-Location }
}

Write-Host "Preparation completed. Follow docs\migration\SETUP_NEW_PC.md for database restore and safe cutover."
