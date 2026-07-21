param(
  [int]$CheckIntervalSeconds = 8,
  [int]$ConsecutiveFailuresBeforeRestart = 2
)

$ErrorActionPreference = "Stop"
$ProjectRoot = if ($env:PROJECT_ROOT) {
  (Resolve-Path $env:PROJECT_ROOT).Path
} else {
  (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RuntimeRoot = Join-Path $ProjectRoot ".runtime"
$LogDir = Join-Path $RuntimeRoot "logs"
$LogPath = Join-Path $LogDir "supervisor.log"
$LockPath = Join-Path $RuntimeRoot "supervisor.lock"
$StartScript = Join-Path $PSScriptRoot "start.ps1"
$ReadinessScript = Join-Path $PSScriptRoot "wait-core-readiness.ps1"

New-Item -ItemType Directory -Force -Path $RuntimeRoot, $LogDir | Out-Null

function Write-SupervisorLog([string]$Message) {
  if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -ge 5MB) {
    if (Test-Path -LiteralPath "$LogPath.4") { Remove-Item -LiteralPath "$LogPath.4" -Force }
    for ($index = 3; $index -ge 1; $index -= 1) {
      $source = "$LogPath.$index"
      if (Test-Path -LiteralPath $source) { Move-Item -LiteralPath $source -Destination "$LogPath.$($index + 1)" -Force }
    }
    Move-Item -LiteralPath $LogPath -Destination "$LogPath.1" -Force
  }
  $line = "{0} {1}{2}" -f (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK"), $Message, [Environment]::NewLine
  [IO.File]::AppendAllText($LogPath, $line, [Text.UTF8Encoding]::new($false))
}

$lock = $null
try {
  $lock = [IO.File]::Open($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch {
  Write-SupervisorLog "another supervisor is already active; duplicate trigger exited"
  exit 0
}

try {
  Write-SupervisorLog "supervisor started"
  $failures = 0
  while ($true) {
    & $ReadinessScript -TimeoutSeconds 4 -StableChecks 1 -Quiet
    if ($LASTEXITCODE -eq 0) {
      $failures = 0
    } else {
      $failures += 1
      Write-SupervisorLog "readiness failure $failures/$ConsecutiveFailuresBeforeRestart"
      if ($failures -ge [Math]::Max(1, $ConsecutiveFailuresBeforeRestart)) {
        try {
          Write-SupervisorLog "recovery started"
          $powershell = Join-Path $PSHOME "powershell.exe"
          $recovery = Start-Process -FilePath $powershell -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $LogDir "supervisor-recovery.out.log") `
            -RedirectStandardError (Join-Path $LogDir "supervisor-recovery.err.log") `
            -ArgumentList @(
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy", "Bypass",
              "-File", $StartScript
            )
          $recovery.WaitForExit()
          & $ReadinessScript -TimeoutSeconds 20 -StableChecks 1 -Quiet
          if ($LASTEXITCODE -ne 0) { throw "start.ps1 exited without restoring core readiness (code $($recovery.ExitCode))" }
          Write-SupervisorLog "recovery completed"
          $failures = 0
        } catch {
          Write-SupervisorLog "recovery failed: $($_.Exception.Message)"
        }
      }
    }
    Start-Sleep -Seconds ([Math]::Max(5, $CheckIntervalSeconds))
  }
} finally {
  Write-SupervisorLog "supervisor stopped"
  if ($lock) { $lock.Dispose() }
}
