[CmdletBinding()]
param([switch]$RestoreMirror)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'backup-health.ps1')
$health = Get-AmbBackupHealth $project
$health | ConvertTo-Json -Depth 6
if ($RestoreMirror) {
  if (!$health.mirrorConfigured -or !$health.mirrorIndependent -or !$health.mirrorReachable -or $health.mirrorVerification -ne 'PASS') {
    throw 'Independent mirror acceptance refused: no verified independent backup set is available'
  }
  & (Join-Path $PSScriptRoot 'test-database-restore.ps1') -MirrorOnly
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $verified = Get-AmbBackupHealth $project
  $verified | ConvertTo-Json -Depth 6
  if ($verified.status -ne 'OK') { throw 'Independent mirror acceptance did not produce an OK health result' }
} elseif ($health.status -eq 'FAIL') { exit 1 }
