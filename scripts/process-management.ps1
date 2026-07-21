function Test-AmbOwnedProcess {
  param(
    $Process,
    [Parameter(Mandatory = $true)][string]$ProjectRoot
  )

  if (!$Process -or $Process.ProcessId -eq $PID) { return $false }
  $name = ([string]$Process.Name).ToLowerInvariant()
  if ($name -notin @("node.exe", "cmd.exe", "powershell.exe", "pwsh.exe")) { return $false }

  $line = if ($null -eq $Process.CommandLine) { "" } else { [string]$Process.CommandLine }
  if (!$line) { return $false }
  $normalizedLine = $line.Replace("/", "\").ToLowerInvariant()
  $normalizedRoot = $ProjectRoot.TrimEnd("\").Replace("/", "\").ToLowerInvariant()

  # A legitimate app entrypoint is always near the beginning of its command
  # line. This avoids matching another application's diagnostic payload that
  # merely happens to contain project paths or old console output.
  $headLength = [Math]::Min(900, $normalizedLine.Length)
  $head = $normalizedLine.Substring(0, $headLength)
  $entrypoints = @(
    "$normalizedRoot\apps\api\dist\server.js",
    "$normalizedRoot\apps\worker\dist\index.js",
    "$normalizedRoot\apps\dashboard\node_modules\next\dist\bin\next",
    "$normalizedRoot\apps\api\src\server.ts",
    "$normalizedRoot\apps\worker\src\index.ts"
  )
  foreach ($entrypoint in $entrypoints) {
    if ($head.Contains($entrypoint)) { return $true }
  }

  if ($name -eq "cmd.exe" -and $head.Contains("cd /d `"$normalizedRoot`"")) {
    return $head.Contains("@amb\api") -or
      $head.Contains("@amb\worker") -or
      $head.Contains("@amb\dashboard") -or
      $head.Contains("dev:api") -or
      $head.Contains("dev:worker")
  }

  return $false
}

function Stop-AmbAppProcesses {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string]$PidDir,
    [int[]]$OwnedPorts = @(3001, 4000)
  )

  $allProcesses = @(Get-CimInstance Win32_Process)
  $rootIds = [System.Collections.Generic.HashSet[int]]::new()
  $stoppedIds = [System.Collections.Generic.HashSet[int]]::new()

  foreach ($process in $allProcesses) {
    if (Test-AmbOwnedProcess -Process $process -ProjectRoot $ProjectRoot) {
      $null = $rootIds.Add([int]$process.ProcessId)
    }
  }

  foreach ($pidFile in Get-ChildItem -LiteralPath $PidDir -Filter "*.pid" -ErrorAction SilentlyContinue) {
    $value = Get-Content -LiteralPath $pidFile.FullName -ErrorAction SilentlyContinue | Select-Object -First 1
    $parsed = 0
    if (![int]::TryParse($value, [ref]$parsed)) { continue }
    $process = $allProcesses | Where-Object { $_.ProcessId -eq $parsed } | Select-Object -First 1
    if (Test-AmbOwnedProcess -Process $process -ProjectRoot $ProjectRoot) {
      $null = $rootIds.Add($parsed)
    }
  }

  foreach ($port in $OwnedPorts) {
    foreach ($listener in Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
      $process = $allProcesses | Where-Object { $_.ProcessId -eq $listener.OwningProcess } | Select-Object -First 1
      if (Test-AmbOwnedProcess -Process $process -ProjectRoot $ProjectRoot) {
        $null = $rootIds.Add([int]$process.ProcessId)
      }
    }
  }

  function Stop-OwnedTree([int]$ProcessId) {
    if ($ProcessId -eq $PID -or $stoppedIds.Contains($ProcessId)) { return }
    $null = $stoppedIds.Add($ProcessId)

    # Descendants are followed only from a root whose exact application
    # signature was validated above. Children are stopped before their parent.
    foreach ($child in $allProcesses | Where-Object { $_.ParentProcessId -eq $ProcessId }) {
      Stop-OwnedTree -ProcessId ([int]$child.ProcessId)
    }

    $process = $allProcesses | Where-Object { $_.ProcessId -eq $ProcessId } | Select-Object -First 1
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    if ($process) {
      Write-Host "Stopped process $($process.ProcessId): $($process.Name)"
    }
  }

  foreach ($rootId in @($rootIds)) {
    Stop-OwnedTree -ProcessId $rootId
  }

  if (Test-Path -LiteralPath $PidDir) {
    Get-ChildItem -LiteralPath $PidDir -Filter "*.pid" -ErrorAction SilentlyContinue |
      Remove-Item -Force -ErrorAction SilentlyContinue
  }
}
