param(
  [int]$TimeoutSeconds = 75,
  [int]$StableChecks = 2,
  [switch]$SingleAttempt,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$ProjectRoot = if ($env:PROJECT_ROOT) {
  (Resolve-Path $env:PROJECT_ROOT).Path
} else {
  (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$PidDir = Join-Path $ProjectRoot ".runtime\pids"
$ProcessManagementScript = Join-Path $PSScriptRoot "process-management.ps1"
. $ProcessManagementScript

function Get-DotEnvValue([string]$Name) {
  $envPath = Join-Path $ProjectRoot ".env"
  if (!(Test-Path -LiteralPath $envPath)) { return "" }
  $line = Get-Content -LiteralPath $envPath -Encoding UTF8 |
    Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } |
    Select-Object -Last 1
  if (!$line) { return "" }
  $value = ($line -split "=", 2)[1].Trim()
  if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'")))) {
    return $value.Substring(1, $value.Length - 2)
  }
  return ($value -replace "\s+#.*$", "").Trim()
}

function Test-RecordedProcess([string]$Name) {
  $pidPath = Join-Path $PidDir "$Name.pid"
  if (!(Test-Path -LiteralPath $pidPath)) { return $false }
  $recordedPid = 0
  $value = Get-Content -LiteralPath $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1
  if (!$value -or ![int]::TryParse($value, [ref]$recordedPid) -or $recordedPid -le 0) { return $false }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $recordedPid" -ErrorAction SilentlyContinue
  return [bool]($process -and (Test-AmbOwnedServiceProcess -Process $process -ProjectRoot $ProjectRoot -ServiceName $Name))
}

function Convert-HeartbeatToUtc($Value) {
  if ($Value -is [datetime]) { return ([datetime]$Value).ToUniversalTime() }
  return [datetimeoffset]::Parse(
    [string]$Value,
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind
  ).UtcDateTime
}

function Test-WorkerHeartbeat([string]$ServiceName, [string]$HeartbeatFile) {
  $pidPath = Join-Path $PidDir "$serviceName.pid"
  $heartbeatPath = Join-Path $ProjectRoot ".runtime\worker-heartbeats\$HeartbeatFile"
  if (!(Test-Path -LiteralPath $pidPath) -or !(Test-Path -LiteralPath $heartbeatPath)) { return $false }
  try {
    $recordedPid = 0
    $heartbeatPid = 0
    $pidValue = Get-Content -LiteralPath $pidPath -ErrorAction Stop | Select-Object -First 1
    $heartbeat = Get-Content -LiteralPath $heartbeatPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $checkedAtUtc = Convert-HeartbeatToUtc $heartbeat.checkedAt
    return [int]::TryParse([string]$pidValue, [ref]$recordedPid) -and
      [int]::TryParse([string]$heartbeat.pid, [ref]$heartbeatPid) -and
      $recordedPid -eq $heartbeatPid -and
      $checkedAtUtc -ge [datetime]::UtcNow.AddSeconds(-20)
  } catch {
    return $false
  }
}

function Test-CoreReady {
  foreach ($name in @("api", "worker-hot-a", "worker-hot-b", "worker-background", "dashboard")) {
    if (!(Test-RecordedProcess $name)) { return $false }
  }
  if (!(Test-WorkerHeartbeat "worker-hot-a" "hot-a.json")) { return $false }
  if (!(Test-WorkerHeartbeat "worker-hot-b" "hot-b.json")) { return $false }
  if (!(Test-WorkerHeartbeat "worker-background" "background.json")) { return $false }

  $leaderHeartbeatPath = Join-Path $ProjectRoot ".runtime\worker-heartbeats\hot.json"
  if (!(Test-Path -LiteralPath $leaderHeartbeatPath)) { return $false }
  try {
    $leader = Get-Content -LiteralPath $leaderHeartbeatPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $leaderCheckedAtUtc = Convert-HeartbeatToUtc $leader.checkedAt
    $hotPids = @("worker-hot-a", "worker-hot-b") | ForEach-Object {
      Get-Content -LiteralPath (Join-Path $PidDir "$_.pid") -ErrorAction Stop | Select-Object -First 1
    }
    if ($leader.leadership -ne "leader" -or
        [string]$leader.pid -notin @($hotPids | ForEach-Object { [string]$_ }) -or
        $leaderCheckedAtUtc -lt [datetime]::UtcNow.AddSeconds(-20)) { return $false }
  } catch { return $false }

  $token = Get-DotEnvValue "LOCAL_API_TOKEN"
  $headers = if ($token) { @{ Authorization = "Bearer $token" } } else { @{} }
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:4000/ready" -Headers $headers -TimeoutSec 3
    if ($health.status -ne "OK") {
      return $false
    }
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:3001/login" -UseBasicParsing -TimeoutSec 5
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

$deadline = (Get-Date).AddSeconds([Math]::Max(5, $TimeoutSeconds))
$stable = 0
do {
  if (Test-CoreReady) {
    $stable += 1
    if ($stable -ge [Math]::Max(1, $StableChecks)) {
      if (!$Quiet) { Write-Host "Core services are ready and stable." }
      exit 0
    }
  } else {
    $stable = 0
  }
  if ($SingleAttempt) { break }
  Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)

if (!$Quiet) { Write-Error "Core services did not become ready within $TimeoutSeconds seconds." }
exit 1
