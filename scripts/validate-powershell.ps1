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
Write-Host "PowerShell syntax validation passed"
