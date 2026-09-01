[CmdletBinding()]
param(
  [int]$TimeoutSeconds = 35,
  [ValidateSet("api", "worker-hot-a", "worker-hot-b", "worker-background", "dashboard")]
  [string[]]$RestartServices = @()
)

$ErrorActionPreference = "Stop"
$ProjectRoot = if ($env:PROJECT_ROOT) {
  (Resolve-Path $env:PROJECT_ROOT).Path
} else {
  (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$RuntimeRoot = Join-Path $ProjectRoot ".runtime"
$LogDir = Join-Path $RuntimeRoot "logs"
$PidDir = Join-Path $RuntimeRoot "pids"
$StartLockPath = Join-Path $RuntimeRoot "start.lock"
$ProcessManagementScript = Join-Path $PSScriptRoot "process-management.ps1"
$EnsureNodeRuntimeScript = Join-Path $PSScriptRoot "ensure-node-runtime.ps1"
$ReadinessScript = Join-Path $PSScriptRoot "wait-core-readiness.ps1"

New-Item -ItemType Directory -Force -Path $RuntimeRoot, $LogDir, $PidDir | Out-Null
. $ProcessManagementScript

$lock = $null
try {
  $lock = [IO.File]::Open(
    $StartLockPath,
    [IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite,
    [IO.FileShare]::None
  )
} catch {
  Write-Error "A full startup or another recovery is already in progress"
  exit 2
}

function Import-ProjectDotEnv {
  $envPath = Join-Path $ProjectRoot ".env"
  if (!(Test-Path -LiteralPath $envPath)) { return }
  foreach ($line in (Get-Content -LiteralPath $envPath -Encoding UTF8)) {
    if ($line -notmatch "^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$") { continue }
    $name = $Matches[1]
    $value = $Matches[2].Trim()
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'")))) {
      $value = $value.Substring(1, $value.Length - 2)
    } else {
      $value = ($value -replace "\s+#.*$", "").Trim()
    }
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}

function Test-ListeningPort([int]$Port) {
  return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Get-ServiceEntrypoint([string]$Name) {
  switch ($Name.ToLowerInvariant()) {
    "api" { return (Join-Path $ProjectRoot "apps\api\dist\server.js") }
    "worker-hot-a" { return (Join-Path $ProjectRoot "apps\worker\dist\index.js") }
    "worker-hot-b" { return (Join-Path $ProjectRoot "apps\worker\dist\index.js") }
    "worker-background" { return (Join-Path $ProjectRoot "apps\worker\dist\index.js") }
    "dashboard" { return (Join-Path $ProjectRoot "apps\dashboard\node_modules\next\dist\bin\next") }
    default { throw "Unknown service: $Name" }
  }
}

function Get-RecordedOwnedProcess([string]$Name) {
  $pidPath = Join-Path $PidDir "$Name.pid"
  if (!(Test-Path -LiteralPath $pidPath)) { return $null }
  $recordedPid = 0
  $value = Get-Content -LiteralPath $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1
  if (!$value -or ![int]::TryParse($value, [ref]$recordedPid) -or $recordedPid -le 0) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $recordedPid" -ErrorAction SilentlyContinue
  if ($process -and (Test-AmbOwnedServiceProcess -Process $process -ProjectRoot $ProjectRoot -ServiceName $Name)) { return $process }
  return $null
}

function Find-OwnedServiceProcess([string]$Name) {
  $entrypoint = (Get-ServiceEntrypoint $Name).Replace("/", "\").ToLowerInvariant()
  $requiredArguments = switch ($Name.ToLowerInvariant()) {
    "worker-hot-a" { @("--role=hot", "--instance=a") }
    "worker-hot-b" { @("--role=hot", "--instance=b") }
    "worker-background" { @("--role=background") }
    default { @() }
  }
  foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue)) {
    $line = if ($null -eq $process.CommandLine) { "" } else { [string]$process.CommandLine }
    $normalizedLine = $line.Replace("/", "\").ToLowerInvariant()
    if ($normalizedLine.Contains($entrypoint) -and
        (@($requiredArguments | Where-Object { !$normalizedLine.Contains($_) }).Count -eq 0) -and
        (Test-AmbOwnedServiceProcess -Process $process -ProjectRoot $ProjectRoot -ServiceName $Name)) {
      return $process
    }
  }
  return $null
}

function Start-NodeService(
  [string]$Name,
  [string]$WorkingDirectory,
  [string[]]$Arguments
) {
  $process = Start-Process `
    -FilePath $script:NodeExe `
    -WindowStyle Hidden `
    -WorkingDirectory $WorkingDirectory `
    -ArgumentList $Arguments `
    -RedirectStandardOutput (Join-Path $LogDir "$Name.out.log") `
    -RedirectStandardError (Join-Path $LogDir "$Name.err.log") `
    -PassThru
  Set-Content -LiteralPath (Join-Path $PidDir "$Name.pid") -Value $process.Id -Encoding ascii
  Write-Host "Recovered $Name (PID $($process.Id))"
}

try {
  Import-ProjectDotEnv
  $postgresPort = if ($env:POSTGRES_PORT) { [int]$env:POSTGRES_PORT } else { 55432 }
  $redisPort = 6380
  if ($env:REDIS_URL) {
    try {
      $redisUri = [Uri]$env:REDIS_URL
      if ($redisUri.Port -gt 0) { $redisPort = $redisUri.Port }
    } catch {
      throw "REDIS_URL is invalid: $($env:REDIS_URL)"
    }
  }
  if (!(Test-ListeningPort $postgresPort)) { throw "PostgreSQL is not listening on port $postgresPort" }
  if (!(Test-ListeningPort $redisPort)) { throw "Redis is not listening on port $redisPort" }

  $artifacts = @(
    (Join-Path $ProjectRoot "packages\shared\dist\index.js"),
    (Join-Path $ProjectRoot "packages\db\dist\index.js"),
    (Join-Path $ProjectRoot "apps\api\dist\server.js"),
    (Join-Path $ProjectRoot "apps\worker\dist\index.js"),
    (Join-Path $ProjectRoot "apps\dashboard\.next\BUILD_ID"),
    (Join-Path $ProjectRoot "apps\dashboard\node_modules\next\dist\bin\next")
  )
  foreach ($artifact in $artifacts) {
    if (!(Test-Path -LiteralPath $artifact)) { throw "Required production artifact is missing: $artifact" }
  }

  $runtime = & $EnsureNodeRuntimeScript -ProjectRoot $ProjectRoot
  $script:NodeExe = $runtime.NodeExe
  if (!$script:NodeExe -or !(Test-Path -LiteralPath $script:NodeExe)) {
    throw "Pinned Node.js runtime is unavailable"
  }
  $env:NODE_ENV = "production"

  foreach ($name in @($RestartServices | Select-Object -Unique)) {
    $recorded = Get-RecordedOwnedProcess $name
    if ($recorded) {
      Stop-Process -Id $recorded.ProcessId -Force -ErrorAction Stop
      Write-Host "Stopped unhealthy $name (PID $($recorded.ProcessId))"
    }
    Remove-Item -LiteralPath (Join-Path $PidDir "$name.pid") -Force -ErrorAction SilentlyContinue
  }

  $missingServices = [System.Collections.Generic.List[string]]::new()
  foreach ($name in @("api", "worker-hot-a", "worker-hot-b", "worker-background", "dashboard")) {
    $recorded = Get-RecordedOwnedProcess $name
    if ($recorded) { continue }

    $existing = Find-OwnedServiceProcess $name
    if ($existing) {
      Set-Content -LiteralPath (Join-Path $PidDir "$name.pid") -Value $existing.ProcessId -Encoding ascii
      Write-Host "Repaired stale $name PID file (PID $($existing.ProcessId))"
      continue
    }
    $missingServices.Add($name)
  }

  if ($missingServices.Count -eq 0) {
    throw "All service processes are present; fast recovery cannot repair this health failure"
  }

  foreach ($name in $missingServices) {
    switch ($name) {
      "api" {
        Start-NodeService "api" (Join-Path $ProjectRoot "apps\api") @(
          "--conditions=production",
          (Join-Path $ProjectRoot "apps\api\dist\server.js")
        )
      }
      "worker-hot-a" {
        Start-NodeService "worker-hot-a" (Join-Path $ProjectRoot "apps\worker") @(
          "--conditions=production",
          (Join-Path $ProjectRoot "apps\worker\dist\index.js"),
          "--role=hot", "--instance=a"
        )
      }
      "worker-hot-b" {
        Start-NodeService "worker-hot-b" (Join-Path $ProjectRoot "apps\worker") @(
          "--conditions=production",
          (Join-Path $ProjectRoot "apps\worker\dist\index.js"),
          "--role=hot", "--instance=b"
        )
      }
      "worker-background" {
        Start-NodeService "worker-background" (Join-Path $ProjectRoot "apps\worker") @(
          "--conditions=production",
          (Join-Path $ProjectRoot "apps\worker\dist\index.js"),
          "--role=background"
        )
      }
      "dashboard" {
        Start-NodeService "dashboard" (Join-Path $ProjectRoot "apps\dashboard") @(
          (Join-Path $ProjectRoot "apps\dashboard\node_modules\next\dist\bin\next"),
          "start", "-H", "127.0.0.1", "-p", "3001"
        )
      }
    }
  }

  & $ReadinessScript -TimeoutSeconds ([Math]::Max(10, $TimeoutSeconds)) -StableChecks 2
  if ($LASTEXITCODE -ne 0) { throw "Targeted processes started, but core readiness was not restored" }
  Write-Host "Fast recovery completed for: $($missingServices -join ', ')"
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
} finally {
  if ($lock) { $lock.Dispose() }
}
