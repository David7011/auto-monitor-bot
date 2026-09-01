[CmdletBinding()]
param(
  [int]$ClientCount = 32,
  [int]$Jobs = 8,
  [int]$TransactionsPerClient = 250,
  [int]$WarmRunSeconds = 10
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$RuntimeBin = Join-Path $ProjectRoot ".runtime\postgresql\bin"
$TestRoot = Join-Path $ProjectRoot ".runtime\postgres-shared-memory-test"
$ResultPath = Join-Path $ProjectRoot ".runtime\postgresql-shared-memory-validation.json"
$DatabaseUser = "amb_shmem_test"
$DatabaseName = "amb_shmem_test"

function Resolve-PostgresTool([string]$Name) {
  $path = Join-Path $RuntimeBin "$Name.exe"
  if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "PostgreSQL runtime tool is missing: $path"
  }
  return $path
}

function Get-FreeTcpPort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

function Remove-TestDirectory([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { return }
  $resolved = [IO.Path]::GetFullPath($Path)
  $prefix = $TestRoot.TrimEnd('\') + '\'
  if (!$resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a path outside the PostgreSQL test root: $resolved"
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}

function Invoke-Pgbench([string[]]$Arguments) {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # pgbench writes normal progress to stderr; Windows PowerShell turns that
    # stream into NativeCommandError when ErrorActionPreference is Stop.
    $ErrorActionPreference = "Continue"
    $lines = @(& $script:Pgbench @Arguments 2>&1 | ForEach-Object {
      $line = [string]$_
      Write-Host $line
      $line
    })
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Lines = $lines }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
}

function Get-LastMetric([string[]]$Lines, [string]$Pattern) {
  $value = $null
  foreach ($line in $Lines) {
    if ($line -match $Pattern) {
      $parsed = 0.0
      if ([double]::TryParse($Matches[1], [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
        $value = $parsed
      }
    }
  }
  return $value
}

$initDb = Resolve-PostgresTool "initdb"
$pgCtl = Resolve-PostgresTool "pg_ctl"
$createdb = Resolve-PostgresTool "createdb"
$script:Pgbench = Resolve-PostgresTool "pgbench"
$psql = Resolve-PostgresTool "psql"
$postgres = Resolve-PostgresTool "postgres"
$version = (& $postgres --version).Trim()
$results = [Collections.Generic.List[object]]::new()
$scenarios = @(
  [pscustomobject]@{ Name = "windows-128mb"; Mode = "windows"; SharedBuffers = "128MB"; Required = $true },
  [pscustomobject]@{ Name = "windows-32mb"; Mode = "windows"; SharedBuffers = "32MB"; Required = $true },
  [pscustomobject]@{ Name = "mmap-128mb"; Mode = "mmap"; SharedBuffers = "128MB"; Required = $false }
)

New-Item -ItemType Directory -Force -Path $TestRoot | Out-Null

foreach ($scenario in $scenarios) {
  $port = Get-FreeTcpPort
  $runId = "$($scenario.Name)-$([Guid]::NewGuid().ToString('N').Substring(0, 10))"
  $runRoot = Join-Path $TestRoot $runId
  $dataDir = Join-Path $runRoot "pgdata"
  $logPath = Join-Path $runRoot "postgres.log"
  $started = $false
  $status = "FAIL"
  $scenarioError = $null
  $setting = ""
  $reportedBuffers = ""
  $churnExitCode = -1
  $warmExitCode = -1
  $connectionTimeMs = $null
  $warmTps = $null
  $errorLines = @()
  try {
    New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
    & $initDb -D $dataDir -U $DatabaseUser -A trust --encoding UTF8 --no-locale *> $null
    if ($LASTEXITCODE -ne 0) { throw "initdb failed" }

    $serverOptions = "-p $port -h 127.0.0.1 -c shared_memory_type=$($scenario.Mode) -c dynamic_shared_memory_type=windows -c shared_buffers=$($scenario.SharedBuffers) -c max_connections=50"
    # Do not pipe pg_ctl output: the detached Windows child can inherit the
    # pipeline handle and keep Windows PowerShell waiting forever.
    & $pgCtl start -D $dataDir -l $logPath -o $serverOptions -w
    if ($LASTEXITCODE -ne 0) {
      if (!$scenario.Required) {
        $status = "UNSUPPORTED"
        $scenarioError = "PostgreSQL did not start with shared_memory_type=$($scenario.Mode)"
        continue
      }
      throw "PostgreSQL failed to start"
    }
    $started = $true

    & $createdb --host=127.0.0.1 "--port=$port" "--username=$DatabaseUser" $DatabaseName *> $null
    if ($LASTEXITCODE -ne 0) { throw "createdb failed" }
    $init = Invoke-Pgbench @("-i", "-s", "1", "--host=127.0.0.1", "--port=$port", "--username=$DatabaseUser", $DatabaseName)
    if ($init.ExitCode -ne 0) { throw "pgbench initialization failed" }

    $settings = @(& $psql --host=127.0.0.1 "--port=$port" "--username=$DatabaseUser" "--dbname=$DatabaseName" --tuples-only --no-align --command "select current_setting('shared_memory_type'), current_setting('shared_buffers');")
    if ($LASTEXITCODE -ne 0 -or $settings.Count -ne 1) { throw "could not read effective settings" }
    $settingParts = ([string]$settings[0]).Trim() -split "\|", 2
    $setting = $settingParts[0]
    $reportedBuffers = $settingParts[1]
    if ($setting -ne $scenario.Mode -or $reportedBuffers -ne $scenario.SharedBuffers) {
      throw "effective settings are shared_memory_type=$setting shared_buffers=$reportedBuffers"
    }

    $churn = Invoke-Pgbench @("-S", "-C", "-c$ClientCount", "-j$Jobs", "-t$TransactionsPerClient", "--host=127.0.0.1", "--port=$port", "--username=$DatabaseUser", $DatabaseName)
    $churnExitCode = $churn.ExitCode
    $connectionTimeMs = Get-LastMetric $churn.Lines "average connection time = ([0-9.]+) ms"
    if ($churnExitCode -ne 0) { throw "pgbench connection churn failed" }

    $warm = Invoke-Pgbench @("-S", "-c$ClientCount", "-j$Jobs", "-T$WarmRunSeconds", "--host=127.0.0.1", "--port=$port", "--username=$DatabaseUser", $DatabaseName)
    $warmExitCode = $warm.ExitCode
    $warmTps = Get-LastMetric $warm.Lines "tps = ([0-9.]+) \(without initial connection time\)"
    if ($warmExitCode -ne 0) { throw "pgbench warm-pool throughput failed" }
    $status = "PASS"
  } catch {
    $scenarioError = $_.Exception.Message
    if ($status -ne "UNSUPPORTED") { $status = "FAIL" }
  } finally {
    if ($started) {
      & $pgCtl stop -D $dataDir -m fast -w
      $started = $false
    }
    if (Test-Path -LiteralPath $logPath) {
      $errorLines = @(Select-String -LiteralPath $logPath -Pattern "error code 487|could not reserve shared memory region" | ForEach-Object { $_.Line })
    }
    if ($errorLines.Count -gt 0 -and $status -eq "PASS") { $status = "FAIL" }
    $results.Add([pscustomobject]@{
      scenario = $scenario.Name
      required = $scenario.Required
      status = $status
      error = $scenarioError
      mode = $scenario.Mode
      reportedMode = $setting
      sharedBuffers = $scenario.SharedBuffers
      reportedSharedBuffers = $reportedBuffers
      clientCount = $ClientCount
      jobs = $Jobs
      transactionsPerClient = $TransactionsPerClient
      connectionChurn = $ClientCount * $TransactionsPerClient
      churnExitCode = $churnExitCode
      averageConnectionTimeMs = $connectionTimeMs
      warmRunSeconds = $WarmRunSeconds
      warmExitCode = $warmExitCode
      warmTps = $warmTps
      sharedMemoryErrors = $errorLines.Count
      errorLines = $errorLines
    })
    Remove-TestDirectory $runRoot
  }
}

$failed = @($results | Where-Object { ($_.required -and $_.status -ne "PASS") -or (!$_.required -and $_.status -notin @("PASS", "UNSUPPORTED")) })
$payload = [ordered]@{
  testedAt = (Get-Date).ToString("o")
  runtime = $version
  result = if ($failed.Count -eq 0) { "PASS" } else { "FAIL" }
  results = @($results)
}
[IO.File]::WriteAllText($ResultPath, ($payload | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))

if ($failed.Count -gt 0) {
  throw "PostgreSQL shared-memory validation failed; see $ResultPath"
}

Write-Host "PostgreSQL Windows shared-memory scenarios passed; unsupported mmap was recorded without hiding it."
Write-Host "Evidence: $ResultPath"
