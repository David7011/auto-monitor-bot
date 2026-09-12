$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'backup-health.ps1')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('amb-backup-health-' + [guid]::NewGuid().ToString('N'))
$project = Join-Path $testRoot 'project'
$local = Join-Path $project '.runtime\backups'
$mirror = Join-Path $testRoot 'mirror'
$drills = Join-Path $project '.runtime\restore-drills'
$checks = 0
$testWritable = $true
$sameDisk = $false
$actualStorage = ${function:Get-AmbStorageIdentity}
$actualWritable = ${function:Test-AmbBackupWritable}
# Synthetic volume identity is limited to this isolated test process. No
# production path is set, and a temp directory is not physical mirror proof.
function Get-AmbStorageIdentity([string]$Path) {
  if ($Path.StartsWith('\\')) { return & $actualStorage $Path }
  if ($Path.StartsWith($mirror, [StringComparison]::OrdinalIgnoreCase)) { return @{ kind = 'LOCAL'; volume = 'synthetic-mirror'; disk = $(if ($sameDisk) { 0 } else { 1 }) } }
  return @{ kind = 'LOCAL'; volume = 'synthetic-local'; disk = 0 }
}
function Test-AmbBackupWritable([string]$Directory) { return $testWritable }
function Assert-True($Condition, [string]$Label) {
  if (!$Condition) { throw "Backup regression failed: $Label" }
  $script:checks++
}
function Assert-Fails([scriptblock]$Operation, [string]$Label) {
  $failed = $false
  try { & $Operation | Out-Null } catch { $failed = $true }
  Assert-True $failed $Label
}
function Write-Set([string]$Directory, [string]$Name = 'database-20260913-000000.ambbak') {
  $archive = Join-Path $Directory $Name
  Copy-Item -LiteralPath $encrypted -Destination $archive
  $hash = Get-AmbBackupHash $archive
  "$hash  $Name" | Set-Content -LiteralPath "$archive.sha256" -Encoding ASCII
  @{ createdAt = (Get-Date).ToString('o'); archive = $Name; sha256 = $hash; bytes = (Get-Item $archive).Length } |
    ConvertTo-Json | Set-Content -LiteralPath "$archive.json" -Encoding UTF8
  return $archive
}
try {
  foreach ($directory in @($local, $mirror, $drills)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
  $encrypted = Join-Path $testRoot 'synthetic.ambbak'
  # Header/hash/transport fixture only; real GCM round-trip/tamper checks remain
  # test:backup-crypto, and real DB restore is test:backup-mirror:restore.
  # This keeps normal CI independent of a preinstalled .runtime Node directory.
  [IO.File]::WriteAllBytes($encrypted, [Text.Encoding]::UTF8.GetBytes('AMBBK001' + ('synthetic ciphertext fixture ' * 100)))
  $archive = Write-Set $local
  Assert-True ((Get-AmbBackupHealth $project).status -eq 'WARN') 'missing mirror warns, does not stop production'
  "BACKUP_MIRROR_PATH=`"$mirror`"" | Set-Content -LiteralPath (Join-Path $project '.env')
  $sameDisk = $true
  Assert-True (!(Test-AmbBackupIndependent $local $local)) 'same volume fails'
  Assert-True ((Get-AmbBackupHealth $project).status -eq 'FAIL') 'same physical disk with different volumes fails'
  $sameDisk = $false
  Assert-True (Test-AmbBackupIndependent $local $mirror) 'synthetic separate disk qualifies'
  Assert-True (Test-AmbBackupIndependent $local '\\backup-server\share\bot') 'remote UNC qualifies'
  Assert-True (!(Test-AmbBackupIndependent $local '\\localhost\share\bot')) 'self-host UNC does not qualify'
  $mirrorArchive = Write-Set $mirror
  $filesBeforeHealth = @(Get-ChildItem -LiteralPath $mirror -Force).Count
  Assert-True ((Get-AmbBackupHealth $project).status -eq 'WARN') 'unproven independent restore warns'
  Assert-True (@(Get-ChildItem -LiteralPath $mirror -Force).Count -eq $filesBeforeHealth) 'health never creates writable probe files'
  $receipt = @{ testedAt = (Get-Date).ToString('o'); result = 'PASS'; source = 'INDEPENDENT_MIRROR'; mirrorIdentity = Get-AmbMirrorIdentity $mirror; filters = 1; listings = 1; observations = 1 }
  $receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $drills 'latest-mirror.json')
  Assert-True ((Get-AmbBackupHealth $project).status -eq 'OK') 'valid independent restore evidence accepted'
  $receipt.result = 'FAIL'
  $receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $drills 'latest-mirror.json')
  Assert-True ((Get-AmbBackupHealth $project).status -eq 'WARN') 'failed restore cannot masquerade as PASS'
  $testWritable = $false
  Assert-True ((Get-AmbBackupHealth $project).status -eq 'FAIL') 'unwritable mirror fails'
  $testWritable = $true
  # Actual ACL check is read-only; no probe file is created by health.
  Assert-True (& $actualWritable $mirror) 'actual temporary-directory writable ACL'
  try {
    $denyAcl = [IO.Directory]::GetAccessControl($mirror)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $deny = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'WriteData, AppendData', 'Deny')
    $denyAcl.AddAccessRule($deny)
    [IO.Directory]::SetAccessControl($mirror, $denyAcl)
    Assert-True (!(& $actualWritable $mirror)) 'actual read-only ACL denies writable health'
  } finally {
    $restoreAcl = [IO.Directory]::GetAccessControl($mirror)
    $restoreAcl.RemoveAccessRuleSpecific($deny)
    [IO.Directory]::SetAccessControl($mirror, $restoreAcl)
  }
  Move-Item -LiteralPath $mirror -Destination "$mirror-offline"
  Assert-True ((Get-AmbBackupHealth $project).status -eq 'FAIL') 'unavailable mirror fails'
  Move-Item -LiteralPath "$mirror-offline" -Destination $mirror
  foreach ($suffix in @('.sha256', '.json')) {
    Move-Item -LiteralPath "$mirrorArchive$suffix" -Destination "$mirrorArchive$suffix.saved"
    Assert-Fails { Get-AmbBackupSet $mirror } "missing $suffix rejected"
    Move-Item -LiteralPath "$mirrorArchive$suffix.saved" -Destination "$mirrorArchive$suffix"
  }
  ('0' * 64) | Set-Content -LiteralPath "$mirrorArchive.sha256"
  Assert-Fails { Get-AmbBackupSet $mirror } 'checksum mismatch rejected'
  $mirrorArchive = Write-Set $mirror
  [IO.File]::WriteAllBytes($mirrorArchive, [Text.Encoding]::ASCII.GetBytes('corrupted'))
  $hash = Get-AmbBackupHash $mirrorArchive
  $hash | Set-Content -LiteralPath "$mirrorArchive.sha256"
  @{ createdAt = (Get-Date).ToString('o'); archive = [IO.Path]::GetFileName($mirrorArchive); sha256 = $hash; bytes = 9 } | ConvertTo-Json | Set-Content -LiteralPath "$mirrorArchive.json"
  Assert-Fails { Get-AmbBackupSet $mirror } 'corrupted header rejected even with matching checksum'
  $mirrorArchive = Write-Set $mirror
  $publishRoot = Join-Path $testRoot 'publish'
  New-Item -ItemType Directory -Path $publishRoot | Out-Null
  Publish-AmbBackupMirror $publishRoot @($archive, "$archive.sha256", "$archive.json") (Get-AmbBackupHash $archive)
  Assert-True ((Get-AmbBackupSet $publishRoot).sha256 -eq (Get-AmbBackupHash $archive)) 'copy verifies archive and complete sidecars'
  Remove-AmbBackupContainedItem $publishRoot (Join-Path $publishRoot ([IO.Path]::GetFileName($archive)))
  Assert-Fails { Publish-AmbBackupMirror $publishRoot @($archive, "$archive.sha256", "$archive.missing") (Get-AmbBackupHash $archive) } 'interrupted staging copy rejected'
  Assert-True (@(Get-ChildItem -LiteralPath $publishRoot -Filter '*.ambbak').Count -eq 0) 'staging interruption never publishes archive'
  Assert-True (@(Get-ChildItem -LiteralPath $publishRoot -Filter '.amb-mirror-*').Count -eq 0) 'owned staging cleaned after interruption'
  Assert-Fails { Publish-AmbBackupMirror $publishRoot @($archive, "$archive.sha256", "$archive.json") ('0' * 64) } 'copy checksum mismatch never publishes'
  $old = Write-Set $mirror 'database-20200101-000000.ambbak'
  (Get-Item $old).LastWriteTime = (Get-Date).AddDays(-30)
  Remove-AmbExpiredBackupSets $mirror (Get-Date).AddDays(-14)
  Assert-True (Test-Path -LiteralPath $old) 'old file timestamp cannot delete a metadata-fresh backup'
  $oldMetadata = Get-Content -LiteralPath "$old.json" -Raw | ConvertFrom-Json
  $oldMetadata.createdAt = (Get-Date).AddDays(-30).ToString('o')
  $oldMetadata | ConvertTo-Json | Set-Content -LiteralPath "$old.json"
  Remove-AmbExpiredBackupSets $mirror (Get-Date).AddDays(-14)
  Assert-True (!(Test-Path -LiteralPath $old)) 'expired owned set removed'
  Assert-True (Test-Path -LiteralPath $mirrorArchive) 'retention preserves fresh archive'
  Assert-Fails { Remove-AmbBackupContainedItem $mirror $archive } 'cleanup cannot escape mirror directory'
  Assert-True (Test-Path -LiteralPath $archive) 'outside local archive remains untouched'
  $set = Get-AmbBackupSet $mirror
  Assert-Fails { Get-AmbBackupSet $mirror ((Get-Date).AddHours(27)) } 'stale backup rejected'
  Assert-True ($set.ageHours -ge 0) 'culture-independent timestamp parsing'
  Write-Host "Backup health regression acceptance passed: $checks assertions; synthetic independent identities only, not a production mirror certification."
} finally {
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\amb-backup-health-'
  if (!$resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test cleanup target escaped owned temp prefix' }
  if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
