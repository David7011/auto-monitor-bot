# Logical mirror transport/restore acceptance. This does not certify physical
# independence: production db:mirror:check remains the fail-closed gate for it.
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'backup-health.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('amb-mirror-restore-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
  $source = Get-AmbBackupSet (Join-Path $project '.runtime\backups')
  Publish-AmbBackupMirror $root @($source.path, "$($source.path).sha256", "$($source.path).json") $source.sha256
  $copied = Get-AmbBackupSet $root
  if ($copied.sha256 -ne $source.sha256) { throw 'Synthetic mirror copy hash mismatch' }
  # A transport hash alone cannot prove authenticated archive integrity.
  # Corrupt the owned temp ciphertext and update its sidecars to exercise the
  # real decryption failure path before any temporary database is created.
  $bytes = [IO.File]::ReadAllBytes($copied.path)
  $bytes[[int]($bytes.Length / 2)] = $bytes[[int]($bytes.Length / 2)] -bxor 1
  [IO.File]::WriteAllBytes($copied.path, $bytes)
  $tamperedHash = Get-AmbBackupHash $copied.path
  $tamperedHash | Set-Content -LiteralPath "$($copied.path).sha256" -Encoding ASCII
  $metadata = Get-Content -LiteralPath "$($copied.path).json" -Raw | ConvertFrom-Json
  $metadata.sha256 = $tamperedHash
  $metadata | ConvertTo-Json | Set-Content -LiteralPath "$($copied.path).json" -Encoding UTF8
  $rejected = $false
  try { & (Join-Path $PSScriptRoot 'test-database-restore.ps1') -ArchivePath $copied.path -LocalOnly -RequireNonEmpty }
  catch { $rejected = $true }
  if (!$rejected) { throw 'Corrupted mirror archive was not rejected by authenticated restore' }
  Publish-AmbBackupMirror $root @($source.path, "$($source.path).sha256", "$($source.path).json") $source.sha256
  & (Join-Path $PSScriptRoot 'test-database-restore.ps1') -ArchivePath $copied.path -LocalOnly -RequireNonEmpty
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host 'Synthetic/temp mirror transport + authenticated real PostgreSQL restore PASS. Physical independence NOT CERTIFIED; no production mirror path was configured.'
} finally {
  $resolved = [IO.Path]::GetFullPath($root)
  $prefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\amb-mirror-restore-'
  if (!$resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Synthetic mirror cleanup escaped owned prefix' }
  if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
