$ErrorActionPreference = "Continue"
$ProjectRoot = if ($env:PROJECT_ROOT) { (Resolve-Path $env:PROJECT_ROOT).Path } else { (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$ProjectRootMsys = "/cygdrive/" + (Split-Path -Qualifier $ProjectRoot).TrimEnd(":").ToLowerInvariant() + "/" + ($ProjectRoot.Substring(3).Replace("\", "/"))
$PostgresPort = if ($env:POSTGRES_PORT) { [int]$env:POSTGRES_PORT } else { 55432 }
$Failed = $false

function Get-DotEnvValue([string]$Name) {
  $envPath = Join-Path $ProjectRoot ".env"
  if (!(Test-Path $envPath)) { return $null }
  $line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match "^\s*$Name\s*=" } | Select-Object -First 1
  if (!$line) { return $null }
  return ($line -replace "^\s*$Name\s*=\s*", "").Trim().Trim('"').Trim("'")
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
Write-Host ""

Write-Host "Ports:"
$ports = @(3001, 4000, $PostgresPort, $RedisPort) | Select-Object -Unique
$portStatus = foreach ($port in $ports) {
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (!$listener) { $Failed = $true }
  [pscustomobject]@{
    Port = $port
    Listening = [bool]$listener
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
} catch {
  Write-Host "Not installed"
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
