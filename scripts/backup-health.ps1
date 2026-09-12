# Shared backup evidence and storage checks. Health functions never write data.
function ConvertTo-AmbBackupUtc($Value) {
  if ($Value -is [datetime]) { return $Value.ToUniversalTime() }
  if ($Value -is [datetimeoffset]) { return $Value.UtcDateTime }
  return [datetimeoffset]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime
}
function Get-AmbBackupHash([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose(); $stream.Dispose() }
}

function Get-AmbBackupSetting([string]$ProjectPath, [string]$Key) {
  $file = Join-Path $ProjectPath '.env'
  if (!(Test-Path -LiteralPath $file)) { return '' }
  $line = Get-Content -LiteralPath $file -Encoding UTF8 | Where-Object { $_ -match "^\s*$([regex]::Escape($Key))\s*=" } | Select-Object -Last 1
  if (!$line) { return '' }
  $value = ($line -split '=', 2)[1].Trim()
  if ($value.Length -ge 2 -and $value[0] -eq $value[$value.Length - 1] -and $value[0] -in @([char]34, [char]39)) { return $value.Substring(1, $value.Length - 2) }
  return ($value -replace '\s+#.*$', '').Trim()
}

function Get-AmbStorageIdentity([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  if ($full.StartsWith('\\')) {
    return @{ kind = 'UNC'; volume = ([IO.Path]::GetPathRoot($full)).ToLowerInvariant(); disk = $null }
  }
  $existing = $full
  while (!(Test-Path -LiteralPath $existing)) {
    $parent = Split-Path -Parent $existing
    if (!$parent -or $parent -eq $existing) { throw 'STORAGE_IDENTITY_UNAVAILABLE' }
    $existing = $parent
  }
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    $nativeModules = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
    Import-Module (Join-Path $nativeModules 'CimCmdlets\CimCmdlets.psd1') -ErrorAction Stop
    Import-Module (Join-Path $nativeModules 'Storage\Storage.psd1') -ErrorAction Stop
  }
  $volume = Get-Volume -FilePath $existing -ErrorAction Stop
  $partitions = @(Get-Partition -ErrorAction Stop | Where-Object { $_.AccessPaths -contains $volume.Path })
  if (!$volume.UniqueId -or $partitions.Count -ne 1) { throw 'STORAGE_IDENTITY_UNAVAILABLE' }
  $disk = Get-Disk -Number $partitions[0].DiskNumber -ErrorAction Stop
  if ([string]$disk.BusType -in @('Virtual', 'File Backed Virtual', 'FileBackedVirtual', 'Spaces')) { throw 'VIRTUAL_STORAGE_INDEPENDENCE_UNPROVEN' }
  return @{ kind = 'LOCAL'; volume = $volume.UniqueId; disk = $partitions[0].DiskNumber; readOnly = [bool]$disk.IsReadOnly }
}

function Test-AmbBackupIndependent([string]$LocalPath, [string]$MirrorPath) {
  $local = Get-AmbStorageIdentity $LocalPath
  $mirror = Get-AmbStorageIdentity $MirrorPath
  if ($local.volume -eq $mirror.volume) { return $false }
  if ($local.kind -eq 'LOCAL' -and $mirror.kind -eq 'LOCAL') { return $local.disk -ne $mirror.disk }
  # Remote share is independent of this laptop's local production disk. A UNC
  # alias pointing back at this same host must not qualify as off-host storage.
  if ($mirror.kind -eq 'UNC') {
    $hostName = ([IO.Path]::GetFullPath($MirrorPath) -split '\\')[2]
    if ($hostName -in @('.', 'localhost', '127.0.0.1', '::1', $env:COMPUTERNAME)) { return $false }
  }
  return $true
}

function Test-AmbBackupWritable([string]$Directory) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $sids = @($identity.User.Value) + @($identity.Groups | ForEach-Object { $_.Value })
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  $allowSids = @($identity.User.Value) + @($identity.Groups | Where-Object { $principal.IsInRole($_) } | ForEach-Object { $_.Value })
  if ((Get-AmbStorageIdentity $Directory).readOnly) { return $false }
  $acl = if ($PSVersionTable.PSVersion.Major -lt 6) { [IO.Directory]::GetAccessControl($Directory) } else { Get-Acl -LiteralPath $Directory -ErrorAction Stop }
  $required = [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData
  $allowed = 0
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.IdentityReference.Value -notin $sids -or ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
    $rights = [int]$rule.FileSystemRights -band [int]$required
    if ($rule.AccessControlType -eq 'Deny' -and $rights) { return $false }
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -in $allowSids) { $allowed = $allowed -bor $rights }
  }
  return ($allowed -band [int]$required) -eq [int]$required
}

function Get-AmbBackupSet([string]$Directory, [datetime]$Now = (Get-Date), [int]$MaxAgeHours = 26) {
  $archive = Get-ChildItem -LiteralPath $Directory -Filter 'database-*.ambbak' -File -ErrorAction Stop |
    Where-Object { $_.Name -match '^database-\d{8}-\d{6}\.ambbak$' } | Sort-Object Name -Descending | Select-Object -First 1
  if (!$archive) { throw 'NO_COMPLETE_BACKUP' }
  if ($archive.Length -le 68) { throw 'ARCHIVE_TRUNCATED' }
  if (!(Test-Path -LiteralPath "$($archive.FullName).sha256" -PathType Leaf)) { throw 'CHECKSUM_MISSING' }
  if (!(Test-Path -LiteralPath "$($archive.FullName).json" -PathType Leaf)) { throw 'METADATA_MISSING' }
  $checksum = ((Get-Content -LiteralPath "$($archive.FullName).sha256" -Raw -ErrorAction Stop) -split '\s+', 2)[0].Trim().ToLowerInvariant()
  $hash = Get-AmbBackupHash $archive.FullName
  if ($checksum -notmatch '^[0-9a-f]{64}$' -or $checksum -ne $hash) { throw 'CHECKSUM_MISMATCH' }
  $stream = [IO.File]::OpenRead($archive.FullName)
  try {
    $header = New-Object byte[] 8
    if ($stream.Read($header, 0, 8) -ne 8 -or [Text.Encoding]::ASCII.GetString($header) -ne 'AMBBK001') { throw 'ARCHIVE_HEADER_INVALID' }
  } finally { $stream.Dispose() }
  $metadata = Get-Content -LiteralPath "$($archive.FullName).json" -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  if ($metadata.archive -ne $archive.Name -or $metadata.sha256 -ne $hash -or [long]$metadata.bytes -ne $archive.Length) { throw 'METADATA_INVALID' }
  $createdAt = ConvertTo-AmbBackupUtc $metadata.createdAt
  $age = ($Now.ToUniversalTime() - $createdAt).TotalHours
  if ($age -lt -0.0833) { throw 'BACKUP_TIMESTAMP_IN_FUTURE' }
  if ($age -gt $MaxAgeHours) { throw 'BACKUP_STALE' }
  return @{ path = $archive.FullName; archive = $archive.Name; sha256 = $hash; createdAt = $createdAt.ToString('o'); ageHours = [Math]::Round([double]$(if ($age -lt 0) { 0 } else { $age }), 2) }
}

function Get-AmbMirrorIdentity([string]$Path) {
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath($Path).TrimEnd('\').ToLowerInvariant())))).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose() }
}

function Get-AmbBackupHealth([string]$ProjectPath, [datetime]$Now = (Get-Date), [int]$MaxAgeHours = 26, [int]$RestoreMaxAgeHours = 168) {
  $localRoot = Join-Path $ProjectPath '.runtime\backups'
  $mirrorRoot = Get-AmbBackupSetting $ProjectPath 'BACKUP_MIRROR_PATH'
  $health = [ordered]@{
    status = 'OK'; checkedAt = $Now.ToUniversalTime().ToString('o'); localBackupAgeHours = $null
    mirrorConfigured = [bool]$mirrorRoot; mirrorReachable = $false; mirrorIndependent = $null; mirrorWritable = $null
    mirrorBackupTimestamp = $null; mirrorVerification = 'NOT_CHECKED'; mirrorVerifiedAt = $null; lastRestoreDrill = $null
    restoreSource = $null; lastIndependentRestore = $null; reasons = @()
  }
  try {
    $local = Get-AmbBackupSet $localRoot $Now ([int]::MaxValue)
    $health.localBackupAgeHours = $local.ageHours
    if ($local.ageHours -gt $MaxAgeHours) { throw 'LOCAL_BACKUP_STALE' }
  }
  catch { $health.status = 'FAIL'; $health.reasons += 'LOCAL_BACKUP_INVALID_OR_STALE' }
  $drillRoot = Join-Path $ProjectPath '.runtime\restore-drills'
  try {
    $last = Get-Content -LiteralPath (Join-Path $drillRoot 'latest.json') -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $health.lastRestoreDrill = @{ result = $last.result; testedAt = $last.testedAt }
    $health.restoreSource = if ($last.source -eq 'INDEPENDENT_MIRROR') { 'INDEPENDENT_MIRROR' } else { 'LOCAL' }
    if ($last.result -ne 'PASS' -and $health.status -ne 'FAIL') { $health.status = 'WARN'; $health.reasons += 'LATEST_RESTORE_FAILED' }
  } catch {}
  if (!$mirrorRoot) {
    if ($health.status -ne 'FAIL') { $health.status = 'WARN' }
    $health.reasons += 'MIRROR_NOT_CONFIGURED'
    return [pscustomobject]$health
  }
  try {
    $health.mirrorIndependent = Test-AmbBackupIndependent $localRoot $mirrorRoot
    if (!$health.mirrorIndependent) { throw 'MIRROR_NOT_INDEPENDENT' }
    if (!(Test-Path -LiteralPath $mirrorRoot -PathType Container)) { throw 'MIRROR_UNAVAILABLE' }
    $health.mirrorReachable = $true
    $health.mirrorWritable = Test-AmbBackupWritable $mirrorRoot
    if (!$health.mirrorWritable) { throw 'MIRROR_NOT_WRITABLE' }
    $mirror = Get-AmbBackupSet $mirrorRoot $Now ([int]::MaxValue)
    $health.mirrorBackupTimestamp = $mirror.createdAt
    if ($mirror.ageHours -gt $MaxAgeHours) { throw 'BACKUP_STALE' }
    $health.mirrorVerification = 'PASS'
    $health.mirrorVerifiedAt = $Now.ToUniversalTime().ToString('o')
    try {
      $receipt = Get-Content -LiteralPath (Join-Path $drillRoot 'latest-mirror.json') -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      if ($receipt.result -ne 'PASS' -or $receipt.source -ne 'INDEPENDENT_MIRROR' -or $receipt.mirrorIdentity -ne (Get-AmbMirrorIdentity $mirrorRoot)) { throw 'MIRROR_RESTORE_NOT_PROVEN' }
      $restoreAge = ($Now.ToUniversalTime() - (ConvertTo-AmbBackupUtc $receipt.testedAt)).TotalHours
      if ($restoreAge -lt -0.0833 -or $restoreAge -gt $RestoreMaxAgeHours) { throw 'MIRROR_RESTORE_STALE' }
      $health.lastIndependentRestore = @{ result = 'PASS'; testedAt = $receipt.testedAt }
    } catch {
      if ($health.status -ne 'FAIL') { $health.status = 'WARN' }
      $health.reasons += 'MIRROR_RESTORE_NOT_PROVEN_OR_STALE'
    }
  } catch {
    $health.status = 'FAIL'
    $health.mirrorVerification = 'FAIL'
    # Never emit exception text containing paths, credentials, or UNC details.
    $code = $_.Exception.Message
    $health.reasons += $(if ($code -match '^[A-Z_]+$') { $code } else { 'MIRROR_CHECK_FAILED' })
  }
  return [pscustomobject]$health
}

function Remove-AmbBackupContainedItem([string]$Directory, [string]$Path, [switch]$Recurse) {
  $root = [IO.Path]::GetFullPath($Directory).TrimEnd('\') + '\'
  $full = [IO.Path]::GetFullPath($Path)
  if (!$full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'CLEANUP_OUTSIDE_BACKUP_ROOT' }
  if ((Split-Path -Parent $full).TrimEnd('\') -ne $root.TrimEnd('\')) { throw 'CLEANUP_NESTED_PATH' }
  if (Test-Path -LiteralPath $full) {
    if ((Get-Item -LiteralPath $full).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'CLEANUP_REPARSE_POINT' }
    Remove-Item -LiteralPath $full -Force -Recurse:$Recurse -ErrorAction Stop
  }
}

function Publish-AmbBackupMirror([string]$Directory, [string[]]$Files, [string]$ExpectedHash) {
  $root = [IO.Path]::GetFullPath($Directory)
  $staging = Join-Path $root ('.amb-mirror-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $staging -ErrorAction Stop | Out-Null
  try {
    foreach ($file in $Files) { Copy-Item -LiteralPath $file -Destination (Join-Path $staging ([IO.Path]::GetFileName($file))) -ErrorAction Stop }
    $archive = $Files | Where-Object { [IO.Path]::GetExtension($_) -eq '.ambbak' } | Select-Object -First 1
    if (!$archive -or (Get-AmbBackupHash (Join-Path $staging ([IO.Path]::GetFileName($archive)))) -ne $ExpectedHash) { throw 'MIRROR_COPY_CHECKSUM_MISMATCH' }
    # Publish the archive last: verified sidecars must precede visibility.
    foreach ($file in @($Files | Where-Object { $_ -ne $archive }) + @($archive)) {
      $name = [IO.Path]::GetFileName($file)
      Move-Item -LiteralPath (Join-Path $staging $name) -Destination (Join-Path $root $name) -Force -ErrorAction Stop
    }
  } finally { Remove-AmbBackupContainedItem $root $staging -Recurse }
}

function Remove-AmbExpiredBackupSets([string]$Directory, [datetime]$Cutoff) {
  Get-ChildItem -LiteralPath $Directory -Filter 'database-*.ambbak' -File -ErrorAction Stop |
    Where-Object { $_.Name -match '^database-\d{8}-\d{6}\.ambbak$' -and $_.LastWriteTime -lt $Cutoff } | ForEach-Object {
      try {
        $metadata = Get-Content -LiteralPath "$($_.FullName).json" -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        if ($metadata.archive -ne $_.Name -or (ConvertTo-AmbBackupUtc $metadata.createdAt) -ge $Cutoff.ToUniversalTime()) { return }
      } catch { return } # Unproven age is not permission to delete data.
      # Retention removes a coherent old set, never unrelated files or staging.
      foreach ($file in @($_.FullName, "$($_.FullName).sha256", "$($_.FullName).json")) { Remove-AmbBackupContainedItem $Directory $file }
    }
}
