[CmdletBinding()]
param([switch]$Apply)

$ErrorActionPreference = "Stop"
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$PowerCfg = Join-Path $env:SystemRoot "System32\powercfg.exe"
$SleepGroup = "238c9fa8-0aad-41ed-83f4-97be242c8f20"
$Settings = [ordered]@{
  SleepIdle = "29f6c1db-86da-48c5-9fdb-f2b67b1f44da"
  HibernateIdle = "9d7815a6-7ee4-497e-8888-515a05f02364"
  UnattendedSleepIdle = "7bc4a2f9-d8fc-4469-b07b-33eb785aaca0"
}

function Invoke-PowerCfg([string[]]$Arguments) {
  $output = & $PowerCfg @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "powercfg $($Arguments -join ' ') failed: $($output -join ' ')"
  }
  return ($output -join "`n")
}

function Get-ActiveScheme {
  $output = Invoke-PowerCfg @('/getactivescheme')
  $match = [regex]::Match($output, '[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}')
  if (!$match.Success) { throw "Cannot determine the active Windows power scheme" }
  return $match.Value
}

function Get-SleepValues([string]$Scheme) {
  foreach ($setting in $Settings.GetEnumerator()) {
    $output = Invoke-PowerCfg @('/qh', $Scheme, $SleepGroup, $setting.Value)
    # The final two hexadecimal values are current AC/DC indices, independent
    # of Windows display language. Fail closed if the output cannot be read.
    $values = [regex]::Matches($output, '0x([0-9a-fA-F]+)')
    if ($values.Count -lt 2) { throw "Cannot read AC/DC values for $($setting.Key)" }
    [pscustomobject]@{
      Name = $setting.Key
      Guid = $setting.Value
      ACSeconds = [Convert]::ToUInt32($values[$values.Count - 2].Groups[1].Value, 16)
      DCSeconds = [Convert]::ToUInt32($values[$values.Count - 1].Groups[1].Value, 16)
    }
  }
}

try {
  $scheme = Get-ActiveScheme
  $before = @(Get-SleepValues $scheme)
  if ($Apply) {
    $backupRoot = Join-Path $ProjectRoot '.runtime\power-policy'
    [IO.Directory]::CreateDirectory($backupRoot) | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $backupPath = Join-Path $backupRoot "before-$stamp.json"
    $preservedBefore = @{
      Battery = Invoke-PowerCfg @('/qh', $scheme, 'SUB_BATTERY')
      Buttons = Invoke-PowerCfg @('/qh', $scheme, 'SUB_BUTTONS')
      Display = Invoke-PowerCfg @('/qh', $scheme, 'SUB_VIDEO')
    }
    @{ capturedAt = (Get-Date).ToString('o'); scheme = $scheme; settings = $before; preserved = $preservedBefore } |
      ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $backupPath -Encoding UTF8
    Write-Host "Original settings saved: $backupPath"
    try {
      foreach ($row in $before) {
        $null = Invoke-PowerCfg @('/setacvalueindex', $scheme, $SleepGroup, $row.Guid, '0')
        $null = Invoke-PowerCfg @('/setdcvalueindex', $scheme, $SleepGroup, $row.Guid, '0')
      }
      if ((Get-ActiveScheme) -ne $scheme) { throw 'Active scheme changed during configuration' }
      $null = Invoke-PowerCfg @('/setactive', $scheme)
      foreach ($pair in @(@('Battery','SUB_BATTERY'), @('Buttons','SUB_BUTTONS'), @('Display','SUB_VIDEO'))) {
        if ((Invoke-PowerCfg @('/qh', $scheme, $pair[1])) -ne $preservedBefore[$pair[0]]) {
          throw "$($pair[0]) settings changed during configuration; inspect concurrent Windows changes"
        }
      }
      $after = @(Get-SleepValues $scheme)
      if (@($after | Where-Object { $_.ACSeconds -ne 0 -or $_.DCSeconds -ne 0 }).Count) {
        throw 'Windows did not retain the requested power settings'
      }
    } catch {
      $originalError = $_
      foreach ($row in $before) {
        $null = Invoke-PowerCfg @('/setacvalueindex', $scheme, $SleepGroup, $row.Guid, [string]$row.ACSeconds)
        $null = Invoke-PowerCfg @('/setdcvalueindex', $scheme, $SleepGroup, $row.Guid, [string]$row.DCSeconds)
      }
      if ((Get-ActiveScheme) -eq $scheme) { $null = Invoke-PowerCfg @('/setactive', $scheme) }
      throw $originalError
    }
  }
  $current = @(Get-SleepValues $scheme)
  if ((Get-ActiveScheme) -ne $scheme) { throw 'Active power scheme changed during verification; retry the check' }
  Write-Host "Power scheme: $scheme"
  $current | Select-Object Name, ACSeconds, DCSeconds | Format-Table -AutoSize
  if (@($current | Where-Object { $_.ACSeconds -ne 0 -or $_.DCSeconds -ne 0 }).Count) {
    throw 'Automatic sleep is enabled. Run .\amb.cmd power:configure to apply the laptop monitoring policy.'
  }
  Write-Host 'Power policy passed: automatic sleep/hibernate timeouts are zero on AC and battery.'
  Write-Host 'Manual power actions, display timeout and critical-battery protection are preserved.'
  exit 0
} catch {
  Write-Host "Power policy FAILED: $($_.Exception.Message)"
  exit 1
}
