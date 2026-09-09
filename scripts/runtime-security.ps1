Set-StrictMode -Version 2.0

function Get-AmbSecurityPolicyPath {
  param([Parameter(Mandatory = $true)][string]$ProjectRoot)

  return Join-Path $ProjectRoot ".runtime\security\acl-policy.conf"
}

function Get-AmbWriteRightsMask {
  return (
    [Security.AccessControl.FileSystemRights]::WriteData -bor
    [Security.AccessControl.FileSystemRights]::AppendData -bor
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership
  )
}

function ConvertTo-AmbSidValue {
  param([Parameter(Mandatory = $true)]$Identity)

  if ($Identity -is [Security.Principal.SecurityIdentifier]) {
    return $Identity.Value
  }
  $reference = if ($Identity -is [Security.Principal.IdentityReference]) {
    $Identity
  } else {
    [Security.Principal.NTAccount]::new([string]$Identity)
  }
  return $reference.Translate([Security.Principal.SecurityIdentifier]).Value
}

function Read-AmbSecurityPolicy {
  param([Parameter(Mandatory = $true)][string]$ProjectRoot)

  $resolvedRoot = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
  $policyPath = Get-AmbSecurityPolicyPath -ProjectRoot $resolvedRoot
  if (!(Test-Path -LiteralPath $policyPath -PathType Leaf)) {
    throw "Runtime ACL policy is missing: $policyPath. Run '.\amb.cmd security:harden' from an elevated shell."
  }

  $values = @{}
  foreach ($line in (Get-Content -LiteralPath $policyPath -Encoding UTF8)) {
    if (!$line -or $line.TrimStart().StartsWith("#")) { continue }
    $parts = $line -split "=", 2
    if ($parts.Count -ne 2) { throw "Malformed runtime ACL policy line: $line" }
    $values[$parts[0].Trim()] = $parts[1].Trim()
  }
  if ([int]$values.version -ne 1) { throw "Unsupported runtime ACL policy version" }
  $policyRoot = [IO.Path]::GetFullPath([string]$values.projectRoot).TrimEnd('\')
  if (![string]::Equals($resolvedRoot, $policyRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Runtime ACL policy belongs to another project path: $policyRoot"
  }

  $allowed = @(([string]$values.allowedWriterSids -split ",") | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
  foreach ($requiredSid in @("S-1-5-18", "S-1-5-32-544")) {
    if ($requiredSid -notin $allowed) { throw "Runtime ACL policy is missing required SID $requiredSid" }
  }
  if ($allowed.Count -lt 3) { throw "Runtime ACL policy does not identify the project owner SID" }

  return [pscustomobject]@{
    Path = $policyPath
    ProjectRoot = $resolvedRoot
    AllowedWriterSids = $allowed
    OwnerSid = [string]$values.ownerSid
  }
}

function Get-AmbAclFindings {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string[]]$AllowedWriterSids,
    [switch]$RequireProtected,
    [switch]$RejectReparsePoint
  )

  $findings = [Collections.Generic.List[string]]::new()
  if (!(Test-Path -LiteralPath $Path)) {
    $findings.Add("required path is missing: $Path")
    return $findings
  }

  $item = Get-Item -LiteralPath $Path -Force
  if ($RejectReparsePoint -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    $findings.Add("security-critical path is a reparse point: $Path")
  }

  $acl = Get-Acl -LiteralPath $Path
  if ($RequireProtected -and !$acl.AreAccessRulesProtected) {
    $findings.Add("ACL inheritance is enabled on protected path: $Path")
  }

  try {
    $ownerSid = ConvertTo-AmbSidValue -Identity $acl.Owner
    if ($ownerSid -notin $AllowedWriterSids) {
      $findings.Add("untrusted owner $ownerSid on $Path")
    }
  } catch {
    $findings.Add("cannot resolve owner '$($acl.Owner)' on $Path")
  }

  $writeMask = Get-AmbWriteRightsMask
  foreach ($rule in $acl.Access) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
    if (($rule.FileSystemRights -band $writeMask) -eq 0) { continue }
    try {
      $sid = ConvertTo-AmbSidValue -Identity $rule.IdentityReference
    } catch {
      $findings.Add("unresolved writable identity '$($rule.IdentityReference.Value)' on $Path")
      continue
    }
    if ($sid -notin $AllowedWriterSids) {
      $findings.Add("untrusted writable SID $sid has $($rule.FileSystemRights) on $Path")
    }
  }

  return $findings
}

function Get-AmbCriticalRuntimePaths {
  param([Parameter(Mandatory = $true)][string]$ProjectRoot)

  $relativePaths = @(
    ".env",
    "amb.cmd",
    "package.json",
    "pnpm-lock.yaml",
    "scripts",
    "scripts\runtime-security.ps1",
    "scripts\assert-runtime-security.ps1",
    "scripts\security-check.cmd",
    "scripts\harden-runtime-acl.cmd",
    "scripts\supervisor.cmd",
    "scripts\supervisor.ps1",
    "scripts\watchdog.cmd",
    "scripts\watchdog.ps1",
    "scripts\backup-database.cmd",
    "scripts\backup-database.ps1",
    "scripts\test-database-restore.cmd",
    "scripts\test-database-restore.ps1",
    "scripts\start.ps1",
    "scripts\process-management.ps1",
    "scripts\runtime-intent.ps1",
    ".runtime\security",
    ".runtime\node-runtime-v2"
  )
  if (Test-Path -LiteralPath (Join-Path $ProjectRoot ".runtime\postgresql")) {
    $relativePaths += ".runtime\postgresql"
  }
  return @($relativePaths | ForEach-Object { Join-Path $ProjectRoot $_ })
}

function Get-AmbTaskSecurityFindings {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string[]]$AllowedWriterSids
  )

  $findings = [Collections.Generic.List[string]]::new()
  if (!(Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) {
    $findings.Add("ScheduledTasks module is unavailable; SYSTEM task definitions cannot be verified")
    return $findings
  }

  $expected = [ordered]@{
    "Auto Monitor Bot" = "scripts\supervisor.cmd"
    "Auto Monitor Bot Watchdog" = "scripts\watchdog.cmd"
    "Auto Monitor Bot Database Backup" = "scripts\backup-database.cmd"
    "Auto Monitor Bot Database Restore Drill" = "scripts\test-database-restore.cmd"
  }
  $expectedCmd = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot "System32\cmd.exe"))

  foreach ($entry in $expected.GetEnumerator()) {
    try {
      $task = Get-ScheduledTask -TaskName $entry.Key -ErrorAction Stop
    } catch {
      $findings.Add("scheduled task '$($entry.Key)' cannot be inspected: $($_.Exception.Message)")
      continue
    }
    if (!$task) {
      $findings.Add("required scheduled task is missing: '$($entry.Key)'")
      continue
    }
    if ($task.TaskPath -ne "\") {
      $findings.Add("scheduled task '$($entry.Key)' is registered outside the root task folder")
    }
    if ($task.State -eq "Disabled") {
      $findings.Add("scheduled task '$($entry.Key)' is disabled")
    }
    if ($task.Principal.UserId -notin @("SYSTEM", "S-1-5-18")) {
      $findings.Add("scheduled task '$($entry.Key)' no longer runs as SYSTEM")
    }
    if ([string]$task.Principal.LogonType -ne "ServiceAccount") {
      $findings.Add("scheduled task '$($entry.Key)' does not use ServiceAccount logon")
    }
    if ([string]$task.Principal.RunLevel -ne "Highest") {
      $findings.Add("scheduled task '$($entry.Key)' does not request the highest run level")
    }
    if ([string]$task.Settings.MultipleInstances -ne "IgnoreNew") {
      $findings.Add("scheduled task '$($entry.Key)' does not reject duplicate instances")
    }
    if ([string]$task.Settings.ExecutionTimeLimit -ne "PT0S") {
      $findings.Add("scheduled task '$($entry.Key)' has an unexpected execution time limit")
    }
    if ($task.Settings.DisallowStartIfOnBatteries -or $task.Settings.StopIfGoingOnBatteries) {
      $findings.Add("scheduled task '$($entry.Key)' is not configured for uninterrupted battery operation")
    }
    if (!$task.Settings.StartWhenAvailable -or [int]$task.Settings.RestartCount -lt 3 -or
        [string]$task.Settings.RestartInterval -ne "PT1M") {
      $findings.Add("scheduled task '$($entry.Key)' recovery settings are weaker than required")
    }

    $triggers = @($task.Triggers)
    if ($triggers.Count -eq 0 -or @($triggers | Where-Object { !$_.Enabled }).Count -gt 0) {
      $findings.Add("scheduled task '$($entry.Key)' has missing or disabled triggers")
    } else {
      $triggerTypes = @($triggers | ForEach-Object { $_.CimClass.CimClassName })
      switch ($entry.Key) {
        "Auto Monitor Bot" {
          if ("MSFT_TaskBootTrigger" -notin $triggerTypes -or "MSFT_TaskLogonTrigger" -notin $triggerTypes) {
            $findings.Add("scheduled task '$($entry.Key)' must start at boot and logon")
          }
        }
        "Auto Monitor Bot Watchdog" {
          $trigger = @($triggers | Where-Object { $_.CimClass.CimClassName -eq "MSFT_TaskTimeTrigger" })[0]
          if (!$trigger -or [string]$trigger.Repetition.Interval -ne "PT1M") {
            $findings.Add("scheduled task '$($entry.Key)' must run every minute")
          }
        }
        "Auto Monitor Bot Database Backup" {
          $trigger = @($triggers | Where-Object { $_.CimClass.CimClassName -eq "MSFT_TaskDailyTrigger" })[0]
          if (!$trigger -or [int]$trigger.DaysInterval -ne 1 -or ([datetime]$trigger.StartBoundary).Hour -ne 3 -or
              ([datetime]$trigger.StartBoundary).Minute -ne 15) {
            $findings.Add("scheduled task '$($entry.Key)' must run daily at 03:15")
          }
        }
        "Auto Monitor Bot Database Restore Drill" {
          $trigger = @($triggers | Where-Object { $_.CimClass.CimClassName -eq "MSFT_TaskWeeklyTrigger" })[0]
          if (!$trigger -or [int]$trigger.WeeksInterval -ne 1 -or ([int]$trigger.DaysOfWeek -band 1) -eq 0 -or
              ([datetime]$trigger.StartBoundary).Hour -ne 4 -or ([datetime]$trigger.StartBoundary).Minute -ne 0) {
            $findings.Add("scheduled task '$($entry.Key)' must run every Sunday at 04:00")
          }
        }
      }
    }
    if (@($task.Actions).Count -ne 1) {
      $findings.Add("scheduled task '$($entry.Key)' has an unexpected action count")
      continue
    }
    $action = @($task.Actions)[0]
    $actualExecutable = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$action.Execute))
    if (![string]::Equals($actualExecutable, $expectedCmd, [StringComparison]::OrdinalIgnoreCase)) {
      $findings.Add("scheduled task '$($entry.Key)' executes unexpected binary: $actualExecutable")
    }
    $expectedLauncher = [IO.Path]::GetFullPath((Join-Path $ProjectRoot $entry.Value))
    $expectedArguments = "/d /s /c `"`"$expectedLauncher`"`""
    if (![string]::Equals(([string]$action.Arguments).Trim(), $expectedArguments, [StringComparison]::OrdinalIgnoreCase)) {
      $findings.Add("scheduled task '$($entry.Key)' has unexpected arguments")
    }
    if (![string]::Equals(([string]$action.WorkingDirectory).TrimEnd('\'), $ProjectRoot, [StringComparison]::OrdinalIgnoreCase)) {
      $findings.Add("scheduled task '$($entry.Key)' has unexpected working directory")
    }

    $taskFile = Join-Path "$env:SystemRoot\System32\Tasks" $entry.Key
    if (!(Test-Path -LiteralPath $taskFile -PathType Leaf)) {
      $findings.Add("scheduled task file is missing or unreadable: $taskFile")
      continue
    }
    foreach ($finding in (Get-AmbAclFindings -Path $taskFile -AllowedWriterSids @("S-1-5-18", "S-1-5-32-544") -RequireProtected)) {
      $findings.Add("task file: $finding")
    }
  }
  return $findings
}

function Test-AmbRuntimeSecurity {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [switch]$SkipScheduledTasks
  )

  $policy = Read-AmbSecurityPolicy -ProjectRoot $ProjectRoot
  $findings = [Collections.Generic.List[string]]::new()
  foreach ($finding in (Get-AmbAclFindings -Path $policy.ProjectRoot -AllowedWriterSids $policy.AllowedWriterSids -RequireProtected -RejectReparsePoint)) {
    $findings.Add($finding)
  }

  foreach ($path in (Get-AmbCriticalRuntimePaths -ProjectRoot $policy.ProjectRoot)) {
    $requireProtected = $path -in @(
      (Join-Path $policy.ProjectRoot ".env"),
      (Join-Path $policy.ProjectRoot "scripts"),
      (Join-Path $policy.ProjectRoot ".runtime\security")
    )
    foreach ($finding in (Get-AmbAclFindings -Path $path -AllowedWriterSids $policy.AllowedWriterSids -RequireProtected:$requireProtected -RejectReparsePoint)) {
      $findings.Add($finding)
    }
  }

  if (!$SkipScheduledTasks) {
    foreach ($finding in (Get-AmbTaskSecurityFindings -ProjectRoot $policy.ProjectRoot -AllowedWriterSids $policy.AllowedWriterSids)) {
      $findings.Add($finding)
    }
  }

  return [pscustomobject]@{
    Secure = $findings.Count -eq 0
    Findings = @($findings)
    PolicyPath = $policy.Path
    AllowedWriterSids = $policy.AllowedWriterSids
  }
}
