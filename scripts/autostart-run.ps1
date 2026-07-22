$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$StartScript = Join-Path $PSScriptRoot "start.ps1"
$LogDir = Join-Path $ProjectRoot ".runtime\logs"
$LogPath = Join-Path $LogDir "autostart-latest.log"
$AttemptLogPath = Join-Path $LogDir ("autostart-{0}.log" -f (Get-Date).ToString("yyyyMMdd-HHmmss"))

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

try {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $records = @(& $StartScript 2>&1)
  $startExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
  $content = ($records | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
  if ($content) { $content += [Environment]::NewLine }
  $utf8 = [Text.UTF8Encoding]::new($false)
  [IO.File]::WriteAllText($AttemptLogPath, $content, $utf8)
  [IO.File]::WriteAllText($LogPath, $content, $utf8)
  if ($startExitCode -ne 0) { throw "start.ps1 exited with code $startExitCode" }
  exit 0
} catch {
  $message = "{0} Autostart failed: {1}" -f (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK"), $_.Exception.Message
  $line = $message + [Environment]::NewLine
  [IO.File]::AppendAllText($LogPath, $line, [Text.UTF8Encoding]::new($false))
  [IO.File]::AppendAllText($AttemptLogPath, $line, [Text.UTF8Encoding]::new($false))
  exit 1
}
