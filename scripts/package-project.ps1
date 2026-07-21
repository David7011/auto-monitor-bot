param(
  [string]$OutputPath = "",
  [switch]$IncludeSecrets,
  [switch]$IncludeDatabaseBackup,
  [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if ($IncludeSecrets -or $IncludeDatabaseBackup) {
  throw "Refusing to place secrets or a database dump in an unencrypted ZIP. Use scripts\backup-database.ps1 for an AES-256 encrypted database backup."
}

function Invoke-ProjectPnpm([string[]]$Arguments) {
  $runtime = & (Join-Path $PSScriptRoot "ensure-node-runtime.ps1")
  & $runtime.PnpmCmd @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $stamp = Get-Date -Format "yyyy-MM-dd-HHmmss"
  $OutputPath = "D:\auto-monitor-bot-clean-$stamp.zip"
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)

if (!$SkipChecks) {
  Write-Host "Running checks before packaging..."
  Push-Location $ProjectRoot
  try {
    Invoke-ProjectPnpm @("typecheck")
    Invoke-ProjectPnpm @("lint")
    Invoke-ProjectPnpm @("test")
    Invoke-ProjectPnpm @("build")
  } finally {
    Pop-Location
  }
}

if ([IO.File]::Exists($OutputPath)) { [IO.File]::Delete($OutputPath) }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$excludeDirs = @(
  "\node_modules\", "\.next\", "\.turbo\", "\.runtime\", "\.codex-logs\",
  "\coverage\", "\test-results\", "\playwright-report\", "\__pycache__\",
  "\dist\", "\build\", "\.git\"
)
$excludeFileNames = @(
  ".env", ".env.local", ".env.test", ".signing.env", "telegram-updates.json"
)

$files = Get-ChildItem -LiteralPath $ProjectRoot -Recurse -File -Force | Where-Object {
  $full = $_.FullName
  if ($excludeFileNames -contains $_.Name) { return $false }
  if ($_.Extension -in @(".log", ".session", ".session-journal", ".pyc", ".pyo", ".tsbuildinfo", ".sqlite", ".sqlite3", ".db", ".dump", ".jks", ".keystore")) { return $false }
  if ($_.Name -in @(".DS_Store", "Thumbs.db", ".eslintcache")) { return $false }
  foreach ($dir in $excludeDirs) {
    if ($full.IndexOf($dir, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $false }
  }
  return $true
}

$archive = [IO.Compression.ZipFile]::Open($OutputPath, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in $files) {
    $entryName = $file.FullName.Substring($ProjectRoot.Length).TrimStart("\").Replace("\", "/")
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive,
      $file.FullName,
      "auto-monitor-bot/$entryName",
      [IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
  }
} finally {
  if ($archive) { $archive.Dispose() }
}

$item = Get-Item -LiteralPath $OutputPath
Write-Host "Created $($item.FullName) ($([math]::Round($item.Length / 1MB, 2)) MB, $($files.Count) source files, no secrets/runtime/database)"
