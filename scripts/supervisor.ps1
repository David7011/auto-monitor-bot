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
$ValidationLockPath = Join-Path $RuntimeRoot "validation.lock"
$StartLockPath = Join-Path $RuntimeRoot "start.lock"

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

function Test-LockHeld([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { return $false }
  $probe = $null
  try {
    $probe = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    return $false
  } catch {
    return $true
  } finally {
    if ($probe) { $probe.Dispose() }
  }
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
  $recoveryAttempt = 0
  $nextRecoveryAt = [datetime]::MinValue
  while ($true) {
    if ((Test-LockHeld $ValidationLockPath) -or (Test-LockHeld $StartLockPath)) {
      $failures = 0
      Start-Sleep -Seconds ([Math]::Max(5, $CheckIntervalSeconds))
      continue
    }
    & $ReadinessScript -TimeoutSeconds 4 -StableChecks 1 -Quiet
    if ($LASTEXITCODE -eq 0) {
      $failures = 0
      $recoveryAttempt = 0
      $nextRecoveryAt = [datetime]::MinValue
    } else {
      $failures += 1
      Write-SupervisorLog "readiness failure $failures/$ConsecutiveFailuresBeforeRestart"
      if ($failures -ge [Math]::Max(1, $ConsecutiveFailuresBeforeRestart) -and (Get-Date) -ge $nextRecoveryAt) {
        try {
          $recoveryAttempt += 1
          Write-SupervisorLog "recovery attempt $recoveryAttempt started"
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
          $recovery.Refresh()
          $recoveryExitCode = $recovery.ExitCode
          & $ReadinessScript -TimeoutSeconds 75 -StableChecks 2 -Quiet
          if ($LASTEXITCODE -ne 0) { throw "start.ps1 exited without restoring core readiness (code $recoveryExitCode)" }
          Write-SupervisorLog "recovery completed"
          $failures = 0
          $recoveryAttempt = 0
          $nextRecoveryAt = [datetime]::MinValue
        } catch {
          Write-SupervisorLog "recovery failed: $($_.Exception.Message)"
          $backoffSeconds = @(15, 30, 60, 120, 300)[[Math]::Min([Math]::Max(0, $recoveryAttempt - 1), 4)]
          $nextRecoveryAt = (Get-Date).AddSeconds($backoffSeconds)
          Write-SupervisorLog "next recovery is allowed after $($nextRecoveryAt.ToString('o'))"
        }
      }
    }
    Start-Sleep -Seconds ([Math]::Max(5, $CheckIntervalSeconds))
  }
} finally {
  Write-SupervisorLog "supervisor stopped"
  if ($lock) { $lock.Dispose() }
}
