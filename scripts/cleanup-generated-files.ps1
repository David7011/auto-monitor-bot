[CmdletBinding()]
param(
  [int]$TempMinimumAgeDays = 14,
  [switch]$SkipSystemTemp
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$removedBytes = [long]0
$removedItems = 0

function Remove-VerifiedItem([string]$Path, [string]$AllowedRoot) {
  $target = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\') + '\'
  if (!$target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a path outside the allowed root: $target"
  }
  if (!(Test-Path -LiteralPath $target)) { return }
  $size = if ((Get-Item -LiteralPath $target -Force).PSIsContainer) {
    (Get-ChildItem -LiteralPath $target -Force -File -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  } else {
    (Get-Item -LiteralPath $target -Force).Length
  }
  Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
  if ($null -eq $size) { $size = 0 }
  $script:removedBytes += [long]$size
  $script:removedItems += 1
}

$downloadRoots = @(
  (Join-Path $ProjectRoot ".runtime\node-runtime\downloads"),
  (Join-Path $ProjectRoot ".runtime\node-runtime-v2\downloads")
)
foreach ($root in $downloadRoots) {
  if (!(Test-Path -LiteralPath $root)) { continue }
  foreach ($archive in (Get-ChildItem -LiteralPath $root -File -Filter "*.zip" -ErrorAction SilentlyContinue)) {
    Remove-VerifiedItem -Path $archive.FullName -AllowedRoot $root
  }
}

$generatedProjectPaths = @(
  (Join-Path $ProjectRoot "apps\dashboard\.next-e2e"),
  (Join-Path $ProjectRoot "apps\dashboard\.next-validation"),
  (Join-Path $ProjectRoot "test-results"),
  (Join-Path $ProjectRoot "playwright-report"),
  (Join-Path $ProjectRoot "packages\shared\.dist-validation"),
  (Join-Path $ProjectRoot "packages\db\.dist-validation"),
  (Join-Path $ProjectRoot "apps\api\.dist-validation"),
  (Join-Path $ProjectRoot "apps\worker\.dist-validation")
)
foreach ($path in $generatedProjectPaths) {
  Remove-VerifiedItem -Path $path -AllowedRoot $ProjectRoot
}

if (!$SkipSystemTemp) {
  $tempRoot = [IO.Path]::GetFullPath($env:TEMP)
  $cutoff = (Get-Date).AddDays(-[Math]::Max(7, $TempMinimumAgeDays))
  foreach ($item in (Get-ChildItem -LiteralPath $tempRoot -Force -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cutoff })) {
    try {
      Remove-VerifiedItem -Path $item.FullName -AllowedRoot $tempRoot
    } catch [System.IO.IOException] {
      # Active application temp files can remain locked; skipping them is safer.
    } catch [System.UnauthorizedAccessException] {
      # Keep temp files owned by another active security context.
    }
  }
}

Write-Host ("Safe cleanup removed {0} item(s), {1:N2} MB." -f $removedItems, ($removedBytes / 1MB))
