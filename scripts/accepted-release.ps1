$script:AmbReleaseArtifactRoots = @(
  "packages\shared\dist",
  "packages\db\dist",
  "apps\api\dist",
  "apps\worker\dist",
  "apps\dashboard\.next"
)

function Get-AmbRelativePath([string]$Root, [string]$Path) {
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $pathFull = [IO.Path]::GetFullPath($Path)
  if (!$pathFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Path is outside release root: $pathFull"
  }
  return $pathFull.Substring($rootFull.Length)
}

function Get-AmbFileSha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
}

function Get-AmbReleaseFiles([string]$ProjectPath) {
  $root = [IO.Path]::GetFullPath($ProjectPath).TrimEnd('\')
  $files = foreach ($relativeRoot in $script:AmbReleaseArtifactRoots) {
    $artifactRoot = Join-Path $root $relativeRoot
    if (!(Test-Path -LiteralPath $artifactRoot -PathType Container)) {
      throw "Accepted release artifact root is missing: $artifactRoot"
    }
    Get-ChildItem -LiteralPath $artifactRoot -File -Recurse -Force | Where-Object {
      $relative = Get-AmbRelativePath $root $_.FullName
      $relative -notlike "apps\dashboard\.next\cache\*" -and
        $relative -ne "apps\dashboard\.next\trace"
    }
  }
  return @($files | Sort-Object FullName -Unique)
}

function Get-AmbTrackedCommit([string]$ProjectPath) {
  $git = Get-Command git.exe -ErrorAction Stop
  $safeDirectory = "safe.directory=$($ProjectPath.Replace('\', '/'))"
  $commit = (& $git.Source -c $safeDirectory -C $ProjectPath rev-parse --verify HEAD 2>$null | Select-Object -First 1).Trim()
  if ($commit -notmatch '^[0-9a-fA-F]{40}$') { throw "Cannot resolve release commit" }
  $dirty = @(& $git.Source -c $safeDirectory -C $ProjectPath status --porcelain --untracked-files=no 2>$null)
  if ($dirty.Count -gt 0) { throw "Refusing to accept a release from a tracked dirty checkout" }
  return $commit.ToLowerInvariant()
}

function New-AmbAcceptedRelease([string]$ProjectPath, [string]$RuntimeVersion) {
  $root = [IO.Path]::GetFullPath($ProjectPath).TrimEnd('\')
  $commit = Get-AmbTrackedCommit $root
  $createdAt = [datetime]::UtcNow
  $releaseId = "{0}-{1}" -f $commit.Substring(0, 12), $createdAt.ToString("yyyyMMddHHmmss")
  $releasesRoot = Join-Path $root ".runtime\releases"
  $staging = Join-Path $releasesRoot (".staging-" + [guid]::NewGuid().ToString("N"))
  $releasePath = Join-Path $releasesRoot $releaseId
  if (Test-Path -LiteralPath $releasePath) { throw "Release already exists: $releaseId" }
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  try {
    $artifacts = foreach ($file in Get-AmbReleaseFiles $root) {
      $relative = Get-AmbRelativePath $root $file.FullName
      $snapshot = Join-Path (Join-Path $staging "artifacts") $relative
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $snapshot) | Out-Null
      Copy-Item -LiteralPath $file.FullName -Destination $snapshot
      [ordered]@{
        path = $relative
        size = $file.Length
        sha256 = Get-AmbFileSha256 $file.FullName
      }
    }
    $schemaPath = Join-Path $root "packages\db\prisma\schema.prisma"
    $migrationIds = @(Get-ChildItem -LiteralPath (Join-Path $root "packages\db\prisma\migrations") -Directory |
      Sort-Object Name | ForEach-Object Name)
    $manifest = [ordered]@{
      format = "amb-accepted-release-v1"
      releaseId = $releaseId
      commit = $commit
      createdAt = $createdAt.ToString("o")
      runtimeVersion = $RuntimeVersion
      schemaSha256 = Get-AmbFileSha256 $schemaPath
      migrationIds = $migrationIds
      artifactRoots = $script:AmbReleaseArtifactRoots
      artifacts = @($artifacts)
    }
    $manifestJson = $manifest | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText((Join-Path $staging "release-manifest.json"), $manifestJson, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $staging -Destination $releasePath
    $activePath = Join-Path $root ".runtime\accepted-release.json"
    $activeTemp = "$activePath.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($activeTemp, $manifestJson, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $activeTemp -Destination $activePath -Force
    [IO.File]::WriteAllText(
      (Join-Path $root ".runtime\accepted-release-required"),
      "accepted release enforcement enabled`n",
      [Text.UTF8Encoding]::new($false)
    )
    return [pscustomobject]$manifest
  } catch {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    throw
  }
}

function Get-AmbAcceptedRelease([string]$ProjectPath) {
  $manifestPath = Join-Path $ProjectPath ".runtime\accepted-release.json"
  if (!(Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "No accepted production release manifest exists: $manifestPath"
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.format -ne "amb-accepted-release-v1" -or $manifest.commit -notmatch '^[0-9a-f]{40}$') {
    throw "Accepted release manifest is invalid"
  }
  return $manifest
}

function Assert-AmbAcceptedRelease([string]$ProjectPath, [string]$RuntimeVersion = "") {
  $root = [IO.Path]::GetFullPath($ProjectPath).TrimEnd('\')
  $manifest = Get-AmbAcceptedRelease $root
  if ($RuntimeVersion -and $manifest.runtimeVersion -ne $RuntimeVersion) {
    throw "Accepted release runtime mismatch: expected $($manifest.runtimeVersion), got $RuntimeVersion"
  }
  foreach ($artifact in @($manifest.artifacts)) {
    $path = [IO.Path]::GetFullPath((Join-Path $root ([string]$artifact.path)))
    if (!$path.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw "Release manifest escapes project root: $($artifact.path)"
    }
    if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "Accepted artifact is missing: $($artifact.path)" }
    $hash = Get-AmbFileSha256 $path
    if ($hash -ne [string]$artifact.sha256) { throw "Accepted artifact checksum mismatch: $($artifact.path)" }
  }
  return $manifest
}

function Restore-AmbAcceptedRelease([string]$ProjectPath, [string]$ReleaseId) {
  $root = [IO.Path]::GetFullPath($ProjectPath).TrimEnd('\')
  if ($ReleaseId -notmatch '^[0-9a-f]{12}-[0-9]{14}$') { throw "Invalid release id" }
  $releasePath = Join-Path $root ".runtime\releases\$ReleaseId"
  $manifestPath = Join-Path $releasePath "release-manifest.json"
  if (!(Test-Path -LiteralPath $manifestPath)) { throw "Release snapshot not found: $ReleaseId" }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($artifact in @($manifest.artifacts)) {
    $snapshot = [IO.Path]::GetFullPath((Join-Path (Join-Path $releasePath "artifacts") ([string]$artifact.path)))
    if (!$snapshot.StartsWith($releasePath + '\', [StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $snapshot)) {
      throw "Release snapshot artifact is missing or unsafe: $($artifact.path)"
    }
    $hash = Get-AmbFileSha256 $snapshot
    if ($hash -ne [string]$artifact.sha256) { throw "Release snapshot checksum mismatch: $($artifact.path)" }
  }
  foreach ($relativeRoot in @($manifest.artifactRoots)) {
    $target = [IO.Path]::GetFullPath((Join-Path $root ([string]$relativeRoot)))
    if (!$target.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe artifact root" }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  }
  foreach ($artifact in @($manifest.artifacts)) {
    $source = Join-Path (Join-Path $releasePath "artifacts") ([string]$artifact.path)
    $target = Join-Path $root ([string]$artifact.path)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item -LiteralPath $source -Destination $target
  }
  Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $root ".runtime\accepted-release.json") -Force
  [IO.File]::WriteAllText(
    (Join-Path $root ".runtime\accepted-release-required"),
    "accepted release enforcement enabled`n",
    [Text.UTF8Encoding]::new($false)
  )
  return Assert-AmbAcceptedRelease $root ([string]$manifest.runtimeVersion)
}
