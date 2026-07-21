$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$StartScript = Join-Path $PSScriptRoot "start.ps1"
$LogDir = Join-Path $ProjectRoot ".runtime\logs"
$LogPath = Join-Path $LogDir "autostart-latest.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

try {
  & $StartScript 2>&1 | Out-File -LiteralPath $LogPath -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw "start.ps1 exited with code $LASTEXITCODE" }
  exit 0
} catch {
  $message = "{0} Autostart failed: {1}" -f (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK"), $_.Exception.Message
  $message | Out-File -LiteralPath $LogPath -Encoding utf8 -Append
  exit 1
}
