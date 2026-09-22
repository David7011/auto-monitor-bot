[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PrismaEntry = Join-Path $ProjectRoot "packages\db\scripts\prisma-with-root-env.mjs"
$Psql = Join-Path $ProjectRoot ".runtime\postgresql\bin\psql.exe"
. (Join-Path $PSScriptRoot "accepted-release.ps1")

# Windows Application Control can reject Prisma's unsigned native migration
# engine even though the JS/WASM validation and generated client are healthy.
# The fallback is intentionally closed: only migrations reviewed as additive
# and pinned by hash may be applied without the Prisma engine.
$FallbackSafe = @{
  "20260921_delivery_state_machine" = "cb084f6af2130c708a18c0d9ee8373890332103b84dbb98e7f6f86920f8a180b"
  "20260922_flash_delivery_state_machine" = "e582013fad602abd6256fbb9bab72595d225b9b4dac6bc8a08fa12fde1144715"
  "20260922_hot_path_trace_boundaries" = "94b4d65d37970ac8481aca263fcca696d2efd2186ec71222a9740297236d06cc"
}

function Get-DotEnvValue([string]$Name) {
  $line = Get-Content -LiteralPath (Join-Path $ProjectRoot ".env") -Encoding UTF8 |
    Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } | Select-Object -Last 1
  if (!$line) { return "" }
  return (($line -split "=", 2)[1]).Trim().Trim('"').Trim("'")
}

function Invoke-Psql([string[]]$Arguments) {
  & $Psql @Arguments
  if ($LASTEXITCODE -ne 0) { throw "psql migration operation failed with exit code $LASTEXITCODE" }
}

$previousLocation = Get-Location
try {
  Set-Location (Join-Path $ProjectRoot "packages\db")
  & node $PrismaEntry migrate deploy
  $prismaExitCode = $LASTEXITCODE
} finally {
  Set-Location $previousLocation
}
if ($prismaExitCode -eq 0) { exit 0 }

$engine = Join-Path $ProjectRoot "node_modules\.pnpm\@prisma+engines@7.9.1\node_modules\@prisma\engines\schema-engine-windows.exe"
$engineBlocked = $false
try {
  & $engine --version *> $null
  $engineBlocked = $LASTEXITCODE -ne 0
} catch {
  $engineBlocked = $_.Exception.Message -match "Application Control|blocked this file|failed to run"
}
if (!$engineBlocked) {
  throw "Prisma migration failed while its native engine remained runnable; refusing the restricted psql fallback"
}
if (!(Test-Path -LiteralPath $Psql -PathType Leaf)) { throw "Project PostgreSQL psql.exe is unavailable" }

$databaseUrl = Get-DotEnvValue "DATABASE_URL"
if (!$databaseUrl) { throw "DATABASE_URL is missing" }
$uri = [Uri]$databaseUrl
$userInfo = [Uri]::UnescapeDataString($uri.UserInfo).Split(':', 2)
$previousPassword = $env:PGPASSWORD
$env:PGPASSWORD = if ($userInfo.Count -gt 1) { $userInfo[1] } else { "" }
$connection = @(
  "--host=$($uri.Host)",
  "--port=$(if ($uri.Port -gt 0) { $uri.Port } else { 5432 })",
  "--username=$($userInfo[0])",
  "--dbname=$([Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart('/')))",
  "--no-password",
  "--set=ON_ERROR_STOP=1"
)

try {
  $ledgerRows = @(& $Psql @connection --tuples-only --no-align --field-separator="|" `
    '--command=SELECT migration_name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;')
  if ($LASTEXITCODE -ne 0) { throw "Cannot read Prisma migration ledger" }
  $applied = @{}
  foreach ($row in $ledgerRows) {
    $parts = ([string]$row).Split('|', 2)
    if ($parts.Count -eq 2) { $applied[$parts[0]] = $parts[1] }
  }

  $migrationRoot = Join-Path $ProjectRoot "packages\db\prisma\migrations"
  foreach ($directory in Get-ChildItem -LiteralPath $migrationRoot -Directory | Sort-Object Name) {
    $name = $directory.Name
    $file = Join-Path $directory.FullName "migration.sql"
    $hash = Get-AmbFileSha256 $file
    if ($applied.ContainsKey($name)) {
      if ([string]$applied[$name] -ne $hash) { throw "Applied migration checksum mismatch: $name" }
      continue
    }
    if (!$FallbackSafe.ContainsKey($name) -or [string]$FallbackSafe[$name] -ne $hash) {
      throw "Pending migration is not approved for the restricted psql fallback: $name"
    }

    Invoke-Psql (@($connection) + @("--single-transaction", "--file=$file"))
    $insert = "INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) VALUES (gen_random_uuid()::text, '$hash', CURRENT_TIMESTAMP, '$name', NULL, NULL, CURRENT_TIMESTAMP, 1);"
    Invoke-Psql (@($connection) + @("--command=$insert"))
    Write-Host "Applied checksum-pinned additive migration through restricted psql fallback: $name"
  }
} finally {
  $env:PGPASSWORD = $previousPassword
}
