$script:AmbRunIntentPath = Join-Path $ProjectRoot ".runtime\run-requested.json"
$script:AmbBootTimeUtc = $null

function Get-AmbBootTimeUtc {
  if ($script:AmbBootTimeUtc) { return $script:AmbBootTimeUtc }
  try {
    $boot = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime
    $script:AmbBootTimeUtc = ([datetime]$boot).ToUniversalTime()
  } catch {
    # A short conservative fallback prevents a stale intent from a previous
    # Windows session from being mistaken for the current boot request.
    $script:AmbBootTimeUtc = [DateTime]::UtcNow.AddMinutes(-5)
  }
  return $script:AmbBootTimeUtc
}

function Set-AmbRunIntent {
  $runtimeRoot = Split-Path -Parent $script:AmbRunIntentPath
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
  $payload = [ordered]@{
    requestedAt = [DateTime]::UtcNow.ToString("o")
    requestedByPid = $PID
  } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($script:AmbRunIntentPath, $payload, [Text.UTF8Encoding]::new($false))
}

function Clear-AmbRunIntent {
  Remove-Item -LiteralPath $script:AmbRunIntentPath -Force -ErrorAction SilentlyContinue
}

function Test-AmbRunIntent {
  if (!(Test-Path -LiteralPath $script:AmbRunIntentPath)) { return $false }
  try {
    $intent = Get-Content -LiteralPath $script:AmbRunIntentPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (!$intent.requestedAt) { return $false }
    $requestedAtUtc = ([datetime]$intent.requestedAt).ToUniversalTime()
    return $requestedAtUtc -ge (Get-AmbBootTimeUtc)
  } catch {
    return $false
  }
}
