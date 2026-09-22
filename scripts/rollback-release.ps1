[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$ReleaseId)
$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "accepted-release.ps1")
$manifest = Restore-AmbAcceptedRelease $ProjectRoot $ReleaseId
Write-Host "Restored accepted release $($manifest.releaseId) at commit $($manifest.commit)"
