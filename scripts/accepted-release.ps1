$script:AmbReleaseArtifactRoots = @(
  "packages\shared\dist",
  "packages\db\dist",
  "apps\api\dist",
  "apps\worker\dist",
  "apps\dashboard\.next"
)
$script:AmbReleaseCandidateRoots = [ordered]@{
  "packages\shared\dist" = "packages\shared\.dist-validation"
  "packages\db\dist" = "packages\db\.dist-validation"
  "apps\api\dist" = "apps\api\.dist-validation"
  "apps\worker\dist" = "apps\worker\.dist-validation"
  "apps\dashboard\.next" = "apps\dashboard\.next-validation"
}

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

function Get-AmbReleaseCandidateArtifacts([string]$ProjectPath) {
  $root = [IO.Path]::GetFullPath($ProjectPath).TrimEnd('\')
  $artifacts = foreach ($activeRoot in $script:AmbReleaseCandidateRoots.Keys) {
    $candidateRoot = [string]$script:AmbReleaseCandidateRoots[$activeRoot]
    $sourceRoot = Join-Path $root $candidateRoot
    if (!(Test-Path -LiteralPath $sourceRoot -PathType Container)) {
      throw "Release candidate root is missing: $sourceRoot"
    }
    foreach ($file in Get-ChildItem -LiteralPath $sourceRoot -File -Recurse -Force) {
      $sourceRelative = Get-AmbRelativePath $sourceRoot $file.FullName
      if ($activeRoot -eq "apps\dashboard\.next" -and
          ($sourceRelative -like "cache\*" -or $sourceRelative -eq "trace")) { continue }
      [ordered]@{
        path = Join-Path $activeRoot $sourceRelative
        sourcePath = Get-AmbRelativePath $root $file.FullName
        size = $file.Length
        sha256 = Get-AmbFileSha256 $file.FullName
      }
    }
  }
  return @($artifacts | Sort-Object path -Unique)
}

function New-AmbReleaseCandidateManifest([string]$ProjectPath, [string]$RuntimeVersion) {
  $root = [IO.Path]::GetFullPath($ProjectPath).TrimEnd('\')
  $commit = Get-AmbTrackedCommit $root
  $candidate = [ordered]@{
    format = "amb-release-candidate-v1"
    commit = $commit
    builtAt = [datetime]::UtcNow.ToString("o")
    runtimeVersion = $RuntimeVersion
    artifacts = @(Get-AmbReleaseCandidateArtifacts $root)
  }
  $path = Join-Path $root ".runtime\release-candidate.json"
  $temp = "$path.$([guid]::NewGuid().ToString('N')).tmp"
  [IO.File]::WriteAllText($temp, ($candidate | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $path -Force
  return [pscustomobject]$candidate
}

function New-AmbAcceptedReleaseFromCandidate([string]$ProjectPath, [string]$RuntimeVersion) {
  $root = [IO.Path]::GetFullPath($ProjectPath).TrimEnd('\')
  $commit = Get-AmbTrackedCommit $root
  $candidatePath = Join-Path $root ".runtime\release-candidate.json"
  if (!(Test-Path -LiteralPath $candidatePath -PathType Leaf)) { throw "Release candidate manifest is missing" }
  $candidate = Get-Content -LiteralPath $candidatePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($candidate.format -ne "amb-release-candidate-v1" -or
      $candidate.commit -ne $commit -or $candidate.runtimeVersion -ne $RuntimeVersion) {
    throw "Release candidate provenance does not match the current clean commit/runtime"
  }

  $currentArtifacts = @(Get-AmbReleaseCandidateArtifacts $root)
  $expected = @($candidate.artifacts)
  if ($currentArtifacts.Count -ne $expected.Count) { throw "Release candidate artifact set changed after build" }
  for ($index = 0; $index -lt $expected.Count; $index++) {
    foreach ($field in @("path", "sourcePath", "sha256", "size")) {
      if ([string]$currentArtifacts[$index][$field] -ne [string]$expected[$index].$field) {
        throw "Release candidate artifact changed after build: $($expected[$index].path)"
      }
    }
  }

  $createdAt = [datetime]::UtcNow
  $releaseId = "{0}-{1}" -f $commit.Substring(0, 12), $createdAt.ToString("yyyyMMddHHmmss")
  $releasesRoot = Join-Path $root ".runtime\releases"
  $staging = Join-Path $releasesRoot (".staging-" + [guid]::NewGuid().ToString("N"))
  $releasePath = Join-Path $releasesRoot $releaseId
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  try {
    $artifacts = foreach ($artifact in $expected) {
      $source = Join-Path $root ([string]$artifact.sourcePath)
      $snapshot = Join-Path (Join-Path $staging "artifacts") ([string]$artifact.path)
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $snapshot) | Out-Null
      Copy-Item -LiteralPath $source -Destination $snapshot
      [ordered]@{ path = [string]$artifact.path; size = [long]$artifact.size; sha256 = [string]$artifact.sha256 }
    }
    $schemaPath = Join-Path $root "packages\db\prisma\schema.prisma"
    $manifest = [ordered]@{
      format = "amb-accepted-release-v1"
      releaseId = $releaseId
      commit = $commit
      createdAt = $createdAt.ToString("o")
      candidateBuiltAt = [string]$candidate.builtAt
      runtimeVersion = $RuntimeVersion
      schemaSha256 = Get-AmbFileSha256 $schemaPath
      migrationIds = @(Get-ChildItem -LiteralPath (Join-Path $root "packages\db\prisma\migrations") -Directory | Sort-Object Name | ForEach-Object Name)
      artifactRoots = $script:AmbReleaseArtifactRoots
      artifacts = @($artifacts)
    }
    [IO.File]::WriteAllText((Join-Path $staging "release-manifest.json"), ($manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $staging -Destination $releasePath
    return [pscustomobject]$manifest
  } catch {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    throw
  }
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
