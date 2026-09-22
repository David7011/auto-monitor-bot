[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "accepted-release.ps1")
$node = & (Join-Path $PSScriptRoot "ensure-node-runtime.ps1") -ProjectRoot $ProjectRoot
$runtimeVersion = (& $node.NodeExe --version).Trim()
$manifest = New-AmbAcceptedReleaseFromCandidate $ProjectRoot $runtimeVersion
[void](Restore-AmbAcceptedRelease $ProjectRoot $manifest.releaseId)
Write-Host "Accepted release $($manifest.releaseId) at commit $($manifest.commit)"
