[CmdletBinding()]
param(
  [int]$DashboardPort = 3001,
  [switch]$StatusOnly,
  [switch]$BuildAndroidApp
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$RuntimeRoot = Join-Path $ProjectRoot ".runtime"
$Tailscale = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
$FirewallRuleName = "Auto Monitor Bot Dashboard (Tailscale)"
$LegacyFirewallRuleNames = @(
  "Auto Monitor Bot Dashboard (Local and VPN)",
  "Auto Monitor Bot Dashboard"
)

function Get-ServeDashboard([object]$ServeConfig, [string]$DnsName, [string]$TailnetIpv4, [int]$Port) {
  if (-not $ServeConfig -or -not $ServeConfig.TCP) { return $null }

  $tcpProperties = @($ServeConfig.TCP.PSObject.Properties)
  $https = $tcpProperties | Where-Object { $_.Name -eq "443" -and $_.Value.HTTPS } | Select-Object -First 1
  if ($https) {
    return [pscustomobject]@{ Url = "https://${DnsName}"; Mode = "private HTTPS" }
  }

  $http = $tcpProperties | Where-Object { $_.Name -eq "80" -and $_.Value.HTTP } | Select-Object -First 1
  if ($http) {
    return [pscustomobject]@{ Url = "http://${DnsName}"; Mode = "private Tailscale HTTP" }
  }

  $tcp = $tcpProperties | Where-Object { $_.Name -eq [string]$Port -and $_.Value.TCPForward } | Select-Object -First 1
  if ($tcp) {
    return [pscustomobject]@{ Url = "http://${TailnetIpv4}:${Port}"; Mode = "private Tailscale TCP" }
  }

  return $null
}

if (-not (Test-Path -LiteralPath $Tailscale)) {
  throw "Tailscale is not installed: $Tailscale"
}

$status = (& $Tailscale status --json | Out-String) | ConvertFrom-Json
if ($status.BackendState -eq "Stopped" -and $status.HaveNodeKey) {
  & $Tailscale up
  if ($LASTEXITCODE -eq 0) {
    Start-Sleep -Seconds 2
    $status = (& $Tailscale status --json | Out-String) | ConvertFrom-Json
  }
}
if ($status.BackendState -ne "Running" -or -not $status.Self.Online) {
  throw "Tailscale is not connected. Sign in once on this computer and rerun the script."
}

$dnsName = ([string]$status.Self.DNSName).Trim().TrimEnd('.')
$tailnetIpv4 = @($status.TailscaleIPs | Where-Object { $_ -match '^100\.' } | Select-Object -First 1)[0]
if (-not $dnsName -or -not $tailnetIpv4) {
  throw "Tailscale did not provide a MagicDNS name and IPv4 address."
}

$serveConfig = $null
try {
  $serveText = (& $Tailscale serve status --json 2>$null | Out-String).Trim()
  if ($serveText -and $serveText -ne "{}" -and $serveText -ne "null") {
    $serveConfig = $serveText | ConvertFrom-Json
  }
} catch {}
$activeDashboard = Get-ServeDashboard $serveConfig $dnsName $tailnetIpv4 $DashboardPort
$remoteUrl = if ($activeDashboard) { $activeDashboard.Url } else { $null }
$result = [ordered]@{
  State = $status.BackendState
  Device = $dnsName
  TailnetIPv4 = $tailnetIpv4
  Dashboard = if ($remoteUrl) { $remoteUrl } else { "not configured" }
  Mode = if ($activeDashboard) { $activeDashboard.Mode } else { "not configured" }
  FirewallRule = $FirewallRuleName
}

if ($StatusOnly) {
  [pscustomobject]$result | Format-List
  exit 0
}

& $Tailscale set --unattended=true
if ($LASTEXITCODE -ne 0) {
  throw "Failed to enable unattended Tailscale mode."
}

$rule = Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue | Select-Object -First 1
if ($rule) { Disable-NetFirewallRule -InputObject $rule | Out-Null }
foreach ($legacyRuleName in $LegacyFirewallRuleNames) {
  Get-NetFirewallRule -DisplayName $legacyRuleName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
}
$result.FirewallRule = "disabled; access is restricted to the tailnet"

New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
& $Tailscale serve reset
if ($LASTEXITCODE -ne 0) { throw "Failed to reset the previous Tailscale Serve configuration." }

$stamp = Get-Date -Format "yyyyMMddHHmmssfff"
$serveStdout = Join-Path $RuntimeRoot "tailscale-serve-$stamp.out.log"
$serveStderr = Join-Path $RuntimeRoot "tailscale-serve-$stamp.err.log"
$serve = Start-Process -FilePath $Tailscale `
  -ArgumentList @("serve", "--bg", "--yes", "--https=443", "http://127.0.0.1:$DashboardPort") `
  -PassThru -WindowStyle Hidden -RedirectStandardOutput $serveStdout -RedirectStandardError $serveStderr
$httpsFailure = $null
try {
  Wait-Process -Id $serve.Id -Timeout 30 -ErrorAction SilentlyContinue
  $serve.Refresh()
  if (!$serve.HasExited) {
    $output = @(
      Get-Content -LiteralPath $serveStdout -Raw -ErrorAction SilentlyContinue
      Get-Content -LiteralPath $serveStderr -Raw -ErrorAction SilentlyContinue
    ) -join "`n"
    if ($output -match "https://login\.tailscale\.com/\S+") {
      $httpsFailure = "one-time tailnet consent required: $($Matches[0])"
    } else {
      $httpsFailure = "configuration timed out"
    }
  } elseif ($serve.ExitCode -ne 0) {
    $output = @(
      Get-Content -LiteralPath $serveStdout -Raw -ErrorAction SilentlyContinue
      Get-Content -LiteralPath $serveStderr -Raw -ErrorAction SilentlyContinue
    ) -join "`n"
    $httpsFailure = $output.Trim()
  }
} finally {
  if (!$serve.HasExited) { Stop-Process -Id $serve.Id -Force -ErrorAction SilentlyContinue }
}

if ($httpsFailure) {
  & $Tailscale serve reset
  if ($LASTEXITCODE -ne 0) { throw "Failed to reset Tailscale Serve after the HTTPS attempt." }
  & $Tailscale serve --bg --yes "--tcp=$DashboardPort" "tcp://127.0.0.1:$DashboardPort"
  if ($LASTEXITCODE -ne 0) { throw "Failed to configure the private Tailscale TCP fallback." }
  $remoteUrl = "http://${tailnetIpv4}:${DashboardPort}"
  $result.Dashboard = $remoteUrl
  $result.Mode = "private Tailscale TCP"
  $result.HttpsUpgrade = $httpsFailure
} else {
  $remoteUrl = "https://${dnsName}"
  $result.Dashboard = $remoteUrl
  $result.Mode = "private HTTPS"
}

try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri "$remoteUrl/login" -TimeoutSec 8
  $result.Probe = "HTTP $([int]$response.StatusCode)"
} catch {
  throw "The private dashboard address is configured but did not answer: $($_.Exception.Message)"
}

[pscustomobject]$result | Format-List

if ($BuildAndroidApp) {
    & (Join-Path $PSScriptRoot "build-android.ps1") -DefaultServerUrl $remoteUrl -SkipSdkUpdate
  if ($LASTEXITCODE -ne 0) { throw "Android build failed." }
}
