$ErrorActionPreference = "Continue"
$ProjectRoot = if ($env:PROJECT_ROOT) { (Resolve-Path $env:PROJECT_ROOT).Path } else { (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$ProjectRootMsys = "/cygdrive/" + (Split-Path -Qualifier $ProjectRoot).TrimEnd(":").ToLowerInvariant() + "/" + ($ProjectRoot.Substring(3).Replace("\", "/"))
$PostgresPort = if ($env:POSTGRES_PORT) { [int]$env:POSTGRES_PORT } else { 55432 }
$Failed = $false
$RuntimeIntentScript = Join-Path $PSScriptRoot "runtime-intent.ps1"
. $RuntimeIntentScript

function Get-DotEnvValue([string]$Name) {
  $envPath = Join-Path $ProjectRoot ".env"
  if (!(Test-Path $envPath)) { return $null }
  $line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match "^\s*$Name\s*=" } | Select-Object -First 1
  if (!$line) { return $null }
  return ($line -replace "^\s*$Name\s*=\s*", "").Trim().Trim('"').Trim("'")
}

function Test-LocalTcpPort([int]$Port) {
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $connect = $client.ConnectAsync("127.0.0.1", $Port)
    return $connect.Wait(1000) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

$LocalApiToken = Get-DotEnvValue "LOCAL_API_TOKEN"
$RedisUrl = Get-DotEnvValue "REDIS_URL"
$RedisPort = 6380
if ($RedisUrl) {
  try {
    $parsedRedisUrl = [Uri]$RedisUrl
    if ($parsedRedisUrl.Port -gt 0) { $RedisPort = $parsedRedisUrl.Port }
  } catch {}
}
$ApiHeaders = if ($LocalApiToken) { @{ Authorization = "Bearer $LocalApiToken" } } else { @{} }

Write-Host "Project: $ProjectRoot"
Write-Host "Drive:   $(Split-Path -Qualifier $ProjectRoot)"
Write-Host "Mode:    $(if (Test-AmbRunIntent) { 'AUTOSTART SESSION ACTIVE' } else { 'STOPPED UNTIL NEXT BOOT OR MANUAL START' })"
Write-Host ""

if (!(Test-AmbRunIntent)) {
  Write-Host "The session was stopped manually. The scheduled supervisor will activate it again at the next Windows boot/logon."
  exit 0
}

Write-Host "Ports:"
$ports = @(3001, 4000, $PostgresPort, $RedisPort) | Select-Object -Unique
$portStatus = foreach ($port in $ports) {
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  $listening = [bool]$listener
  if (!$listening) { $listening = Test-LocalTcpPort $port }
  if (!$listening) { $Failed = $true }
  [pscustomobject]@{
    Port = $port
    Listening = $listening
    OwningProcess = if ($listener) { $listener.OwningProcess } else { $null }
  }
}
$portStatus | Format-Table -AutoSize

Write-Host ""
Write-Host "Project processes:"
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$ProjectRoot*" -or $_.CommandLine -like "*$ProjectRootMsys*" } |
  Select-Object ProcessId, Name, @{Name = "Command"; Expression = { $_.CommandLine.Substring(0, [Math]::Min(140, $_.CommandLine.Length)) } } |
  Format-Table -AutoSize

$PidDir = Join-Path $ProjectRoot ".runtime\pids"
if (Test-Path $PidDir) {
  Write-Host ""
  Write-Host "Recorded PIDs:"
  Get-ChildItem -LiteralPath $PidDir -Filter "*.pid" -ErrorAction SilentlyContinue |
    ForEach-Object {
      [pscustomobject]@{ Name = $_.BaseName; PID = (Get-Content -LiteralPath $_.FullName -ErrorAction SilentlyContinue) }
    } |
    Format-Table -AutoSize
}

Write-Host ""
Write-Host "Autostart:"
try {
  $tasks = @(
    Get-ScheduledTask -TaskName "Auto Monitor Bot" -ErrorAction Stop
    Get-ScheduledTask -TaskName "Auto Monitor Bot Watchdog" -ErrorAction Stop
    Get-ScheduledTask -TaskName "Auto Monitor Bot Database Backup" -ErrorAction Stop
    Get-ScheduledTask -TaskName "Auto Monitor Bot Database Restore Drill" -ErrorAction Stop
  )
  $tasks | Select-Object TaskName, State | Format-Table -AutoSize
  $supervisorProcess = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*scripts\supervisor.ps1*" } |
    Select-Object -First 1
  Write-Host "Supervisor active: $([bool]$supervisorProcess)"
  $supervisorHeartbeatPath = Join-Path $ProjectRoot ".runtime\supervisor-heartbeat.json"
  if (Test-Path -LiteralPath $supervisorHeartbeatPath) {
    try {
      $supervisorHeartbeat = Get-Content -LiteralPath $supervisorHeartbeatPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $heartbeatAt = [datetime]$supervisorHeartbeat.checkedAt
      $heartbeatAgeSeconds = [Math]::Max(0, [Math]::Round(((Get-Date) - $heartbeatAt).TotalSeconds, 1))
      $heartbeatFresh = $heartbeatAgeSeconds -le 30
      Write-Host "Supervisor heartbeat: $($supervisorHeartbeat.phase), age ${heartbeatAgeSeconds}s, fresh=$heartbeatFresh"
      if ($supervisorProcess -and !$heartbeatFresh) { $Failed = $true }
    } catch {
      Write-Host "Supervisor heartbeat is unreadable: $($_.Exception.Message)"
      if ($supervisorProcess) { $Failed = $true }
    }
  } else {
    Write-Host "Supervisor heartbeat: missing"
    if ($supervisorProcess) { $Failed = $true }
  }
} catch {
  Write-Host "Autostart inspection is unavailable: $($_.Exception.Message)"
}

Write-Host ""
Write-Host "Remote control:"
$tailscale = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
if (Test-Path -LiteralPath $tailscale) {
  try {
    $tailscaleStatus = (& $tailscale status --json | Out-String) | ConvertFrom-Json
    $dnsName = ([string]$tailscaleStatus.Self.DNSName).Trim().TrimEnd('.')
    $tailnetIpv4 = @($tailscaleStatus.TailscaleIPs | Where-Object { $_ -match '^100\.' } | Select-Object -First 1)[0]
    $serveJson = (& $tailscale serve status --json 2>$null | Out-String).Trim()
    $serveConfigured = $serveJson -and $serveJson -ne "{}" -and $serveJson -ne "null"
    $dashboardUrl = $null
    $serveMode = "not configured"
    if ($serveConfigured) {
      $serve = $serveJson | ConvertFrom-Json
      $tcpProperties = @($serve.TCP.PSObject.Properties)
      if ($tcpProperties | Where-Object { $_.Name -eq "443" -and $_.Value.HTTPS }) {
        $dashboardUrl = "https://${dnsName}"
        $serveMode = "private HTTPS"
      } elseif ($tcpProperties | Where-Object { $_.Name -eq "80" -and $_.Value.HTTP }) {
        $dashboardUrl = "http://${dnsName}"
        $serveMode = "private Tailscale HTTP"
      } elseif ($tcpProperties | Where-Object { $_.Name -eq "3001" -and $_.Value.TCPForward }) {
        $dashboardUrl = "http://${tailnetIpv4}:3001"
        $serveMode = "private Tailscale TCP"
      }
    }
    [pscustomobject]@{
      state = $tailscaleStatus.BackendState
      device = $dnsName
      dashboard = if ($dashboardUrl) { $dashboardUrl } else { "not configured (run pnpm remote:setup)" }
      mode = $serveMode
      firewall = if ($dashboardUrl) { "not required; access is restricted to the tailnet" } else { "dashboard remains localhost-only" }
    } | Format-List
  } catch {
    Write-Host "Tailscale status is not reachable: $($_.Exception.Message)"
  }
} else {
  Write-Host "Tailscale is not installed"
}

Write-Host ""
Write-Host "Core readiness:"
try {
  $ready = Invoke-RestMethod "http://localhost:4000/ready" -Headers $ApiHeaders -TimeoutSec 5
  $ready | ConvertTo-Json -Depth 3
  if ($ready.status -ne "OK") { $Failed = $true }
} catch {
  Write-Host "Core readiness failed: $($_.Exception.Message)"
  $Failed = $true
}

Write-Host ""
Write-Host "API health:"
try {
  $health = Invoke-RestMethod "http://localhost:4000/health" -Headers $ApiHeaders -TimeoutSec 5
  $health | ConvertTo-Json -Depth 4
  if ($health.sourceHealth) {
    Write-Host ""
    Write-Host "Target source freshness:"
    $health.sourceHealth | Select-Object source,status,sourceStatus,lastCheckedAt,staleAfterSeconds,message | Format-Table -AutoSize
  }
} catch {
  Write-Host "API is not reachable: $($_.Exception.Message)"
  $Failed = $true
}

Write-Host ""
Write-Host "Encrypted database backup:"
$latestBackup = Get-ChildItem -LiteralPath (Join-Path $ProjectRoot ".runtime\backups") -Filter "database-*.7z" -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($latestBackup) {
  $latestBackup | Select-Object FullName,Length,LastWriteTime | Format-List
} else {
  Write-Host "No encrypted backup found"
}

Write-Host ""
Write-Host "Monitoring:"
try {
  $status = Invoke-RestMethod "http://localhost:4000/monitoring/status" -Headers $ApiHeaders -TimeoutSec 10
  [pscustomobject]@{
    status = $status.state.status
    lastTickAt = $status.state.lastTickAt
    nextTickAt = $status.state.nextTickAt
    activeFilters = $status.filters.activeReal
    totalFilters = $status.filters.total
    telegramConfigured = $status.telegramConfigured
  } | Format-List

  $status.sources |
    Select-Object source, enabled, status, lastCheckedAt, lastError |
    Format-Table -AutoSize
} catch {
  Write-Host "Monitoring status is not reachable: $($_.Exception.Message)"
  $Failed = $true
}

if ($Failed) { exit 1 }
exit 0
