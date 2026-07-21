[CmdletBinding()]
param(
  [string]$DefaultServerUrl = "",
  [string]$LanServerUrl = "",
  [switch]$SkipSdkUpdate
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$AndroidProject = Join-Path $ProjectRoot "apps\mobile-android"
$RuntimeRoot = Join-Path $ProjectRoot ".runtime\android"
$DownloadRoot = Join-Path $RuntimeRoot "downloads"
$JdkRoot = Join-Path $RuntimeRoot "jdk-17"
$SdkRoot = Join-Path $RuntimeRoot "sdk"
$GradleRoot = Join-Path $RuntimeRoot "gradle-9.3.1"
$GradleUserHome = Join-Path $RuntimeRoot "gradle-home"
$AndroidUserHome = Join-Path $RuntimeRoot "android-home"
$SigningRoot = Join-Path $ProjectRoot ".runtime\android-signing"
$SigningEnvPath = Join-Path $AndroidProject ".signing.env"
$OutputApk = Join-Path $ProjectRoot "Auto-Monitor-Bot-Android.apk"
$OutputHash = Join-Path $ProjectRoot "Auto-Monitor-Bot-Android.sha256.txt"
$OutputManifest = Join-Path $ProjectRoot "Auto-Monitor-Bot-Android.release.json"

$JdkUrl = "https://aka.ms/download-jdk/microsoft-jdk-17.0.19-windows-x64.zip"
$JdkSha256 = "394d1d8253d58b462300f15f9c81369478cf8813f82dca914c3b5dfdef080f9f"
$CommandLineToolsUrl = "https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip"
$CommandLineToolsSha256 = "90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a"
$GradleUrl = "https://services.gradle.org/distributions/gradle-9.3.1-bin.zip"
$GradleSha256 = "b266d5ff6b90eada6dc3b20cb090e3731302e553a27c5d3e4df1f0d76beaff06"

function Assert-ProjectPath([string]$Path) {
  $resolved = [System.IO.Path]::GetFullPath($Path)
  $rootWithSeparator = $ProjectRoot.TrimEnd('\') + '\'
  if (-not $resolved.StartsWith($rootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a path outside the project: $resolved"
  }
}

function Remove-ProjectItem([string]$Path) {
  Assert-ProjectPath $Path
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Assert-FileHash([string]$Path, [string]$ExpectedSha256) {
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
    throw "SHA-256 mismatch for $(Split-Path $Path -Leaf): expected $ExpectedSha256, got $actual"
  }
}

function Download-File([string]$Url, [string]$Destination, [string]$ExpectedSha256) {
  Assert-ProjectPath $Destination
  if (Test-Path -LiteralPath $Destination) {
    try {
      Assert-FileHash $Destination $ExpectedSha256
      Write-Host "Using verified cached $(Split-Path $Destination -Leaf)"
      return
    } catch {
      Write-Warning $_.Exception.Message
      Remove-ProjectItem $Destination
    }
  }

  $partial = "$Destination.partial"
  Remove-ProjectItem $partial
  Write-Host "Downloading $Url"
  & curl.exe --fail --location --retry 3 --retry-delay 2 --output $partial $Url
  if ($LASTEXITCODE -ne 0) {
    Remove-ProjectItem $partial
    throw "Download failed: $Url"
  }
  try {
    Assert-FileHash $partial $ExpectedSha256
  } catch {
    Remove-ProjectItem $partial
    throw
  }
  Move-Item -LiteralPath $partial -Destination $Destination
}

function Expand-ZipFresh([string]$Archive, [string]$Destination) {
  Remove-ProjectItem $Destination
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
}

function New-RandomSecret([int]$Bytes = 32) {
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($buffer)
  } finally {
    $rng.Dispose()
  }
  return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Read-KeyValueFile([string]$Path) {
  $result = @{}
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#') -or -not $trimmed.Contains('=')) { continue }
    $parts = $trimmed.Split('=', 2)
    $result[$parts[0].Trim()] = $parts[1].Trim()
  }
  return $result
}

function Resolve-LanServerUrl {
  if ($LanServerUrl.Trim()) { return $LanServerUrl.Trim().TrimEnd('/') }

  $wifi = Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Wi-Fi" -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "169.254.*" } |
    Select-Object -First 1
  if ($wifi) { return "http://$($wifi.IPAddress):3001" }

  $network = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike "127.*" -and
      $_.IPAddress -notlike "169.254.*" -and
      $_.InterfaceAlias -notmatch "Loopback|WSL|Docker|vEthernet"
    } |
    Select-Object -First 1
  if ($network) { return "http://$($network.IPAddress):3001" }
  return "http://192.168.0.106:3001"
}

function Resolve-DefaultServerUrl([string]$ResolvedLanServerUrl) {
  if ($DefaultServerUrl.Trim()) { return $DefaultServerUrl.Trim().TrimEnd('/') }

  $tailscale = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
  if (Test-Path -LiteralPath $tailscale) {
    try {
      $status = (& $tailscale status --json 2>$null | Out-String) | ConvertFrom-Json
      $dnsName = [string]$status.Self.DNSName
      $tailnetIpv4 = @($status.TailscaleIPs | Where-Object { $_ -match '^100\.' } | Select-Object -First 1)[0]
      $serveText = (& $tailscale serve status --json 2>$null | Out-String).Trim()
      if ($serveText -and $serveText -ne "{}" -and $serveText -ne "null") {
        $serve = $serveText | ConvertFrom-Json
        $tcpProperties = @($serve.TCP.PSObject.Properties)
        if ($status.HaveNodeKey -and $dnsName.Trim() -and
            ($tcpProperties | Where-Object { $_.Name -eq "443" -and $_.Value.HTTPS })) {
          return "https://$($dnsName.Trim().TrimEnd('.'))"
        }
        if ($tailnetIpv4 -and
            ($tcpProperties | Where-Object { $_.Name -eq "3001" -and $_.Value.TCPForward })) {
          return "http://${tailnetIpv4}:3001"
        }
      }
    } catch {
      Write-Verbose "Tailscale address was not detected: $($_.Exception.Message)"
    }
  }

  return $ResolvedLanServerUrl
}

foreach ($path in @($RuntimeRoot, $DownloadRoot, $SdkRoot, $GradleUserHome, $AndroidUserHome, $SigningRoot)) {
  Assert-ProjectPath $path
  New-Item -ItemType Directory -Force -Path $path | Out-Null
}

if (-not (Test-Path -LiteralPath (Join-Path $JdkRoot "bin\javac.exe"))) {
  $jdkArchive = Join-Path $DownloadRoot "jdk17.zip"
  $jdkExtract = Join-Path $RuntimeRoot "jdk-extract"
  Download-File $JdkUrl $jdkArchive $JdkSha256
  Expand-ZipFresh $jdkArchive $jdkExtract
  $jdkSource = Get-ChildItem -LiteralPath $jdkExtract -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "bin\javac.exe") } |
    Select-Object -First 1
  if (-not $jdkSource) { throw "Portable JDK was not found in the downloaded archive" }
  Remove-ProjectItem $JdkRoot
  Move-Item -LiteralPath $jdkSource.FullName -Destination $JdkRoot
  Remove-ProjectItem $jdkExtract
}

$sdkManager = Join-Path $SdkRoot "cmdline-tools\latest\bin\sdkmanager.bat"
if (-not (Test-Path -LiteralPath $sdkManager)) {
  $toolsArchive = Join-Path $DownloadRoot "android-commandline-tools.zip"
  $toolsExtract = Join-Path $RuntimeRoot "commandline-tools-extract"
  Download-File $CommandLineToolsUrl $toolsArchive $CommandLineToolsSha256
  Expand-ZipFresh $toolsArchive $toolsExtract
  $toolsSource = Join-Path $toolsExtract "cmdline-tools"
  if (-not (Test-Path -LiteralPath (Join-Path $toolsSource "bin\sdkmanager.bat"))) {
    throw "sdkmanager was not found in the Android command-line tools archive"
  }
  $commandLineRoot = Join-Path $SdkRoot "cmdline-tools"
  New-Item -ItemType Directory -Force -Path $commandLineRoot | Out-Null
  $latest = Join-Path $commandLineRoot "latest"
  Remove-ProjectItem $latest
  Move-Item -LiteralPath $toolsSource -Destination $latest
  Remove-ProjectItem $toolsExtract
}

if (-not (Test-Path -LiteralPath (Join-Path $GradleRoot "bin\gradle.bat"))) {
  $gradleArchive = Join-Path $DownloadRoot "gradle-9.3.1-bin.zip"
  $gradleExtract = Join-Path $RuntimeRoot "gradle-extract"
  Download-File $GradleUrl $gradleArchive $GradleSha256
  Expand-ZipFresh $gradleArchive $gradleExtract
  $gradleSource = Join-Path $gradleExtract "gradle-9.3.1"
  if (-not (Test-Path -LiteralPath (Join-Path $gradleSource "bin\gradle.bat"))) {
    throw "Gradle was not found in the downloaded archive"
  }
  Remove-ProjectItem $GradleRoot
  Move-Item -LiteralPath $gradleSource -Destination $GradleRoot
  Remove-ProjectItem $gradleExtract
}

$env:JAVA_HOME = $JdkRoot
$env:ANDROID_HOME = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot
$env:ANDROID_USER_HOME = $AndroidUserHome
$env:GRADLE_USER_HOME = $GradleUserHome
$env:Path = "$(Join-Path $JdkRoot 'bin');$(Join-Path $SdkRoot 'platform-tools');$env:Path"

$sdkPropertyPath = $SdkRoot.Replace('\', '/').Replace(':', '\:')
$localProperties = "sdk.dir=$sdkPropertyPath`n"
Set-Content -LiteralPath (Join-Path $AndroidProject "local.properties") -Value $localProperties -Encoding ASCII

if (-not $SkipSdkUpdate -or
    -not (Test-Path -LiteralPath (Join-Path $SdkRoot "platforms\android-36\android.jar")) -or
    -not (Test-Path -LiteralPath (Join-Path $SdkRoot "build-tools\36.0.0\apksigner.bat"))) {
  Write-Host "Accepting Android SDK licenses"
  ((1..100 | ForEach-Object { "y" }) -join [Environment]::NewLine) |
    & $sdkManager "--sdk_root=$SdkRoot" --licenses | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Android SDK license acceptance failed" }

  Write-Host "Installing Android SDK packages"
  & $sdkManager "--sdk_root=$SdkRoot" "platform-tools" "platforms;android-36" "build-tools;36.0.0"
  if ($LASTEXITCODE -ne 0) { throw "Android SDK package installation failed" }
}

$keyStore = Join-Path $SigningRoot "auto-monitor-release.jks"
if (-not (Test-Path -LiteralPath $SigningEnvPath)) {
  $storePassword = New-RandomSecret 30
  $keyPassword = $storePassword
  $keyAlias = "auto-monitor"
  @(
    "KEYSTORE=$keyStore"
    "STORE_PASSWORD=$storePassword"
    "KEY_ALIAS=$keyAlias"
    "KEY_PASSWORD=$keyPassword"
  ) | Set-Content -LiteralPath $SigningEnvPath -Encoding ASCII
}

$signing = Read-KeyValueFile $SigningEnvPath
foreach ($key in @("KEYSTORE", "STORE_PASSWORD", "KEY_ALIAS", "KEY_PASSWORD")) {
  if (-not $signing.ContainsKey($key) -or -not $signing[$key]) { throw "Missing $key in $SigningEnvPath" }
}

if (-not (Test-Path -LiteralPath $signing.KEYSTORE)) {
  Assert-ProjectPath $signing.KEYSTORE
  Write-Host "Creating Android release signing key"
  & (Join-Path $JdkRoot "bin\keytool.exe") -genkeypair -v `
    -keystore $signing.KEYSTORE `
    -storepass $signing.STORE_PASSWORD `
    -alias $signing.KEY_ALIAS `
    -keypass $signing.KEY_PASSWORD `
    -keyalg RSA `
    -keysize 4096 `
    -validity 10000 `
    -dname "CN=Auto Monitor Bot, OU=Personal, O=DneprDavid, C=UA"
  if ($LASTEXITCODE -ne 0) { throw "Android signing key generation failed" }
}

$env:AMB_ANDROID_KEYSTORE = $signing.KEYSTORE
$env:AMB_ANDROID_STORE_PASSWORD = $signing.STORE_PASSWORD
$env:AMB_ANDROID_KEY_ALIAS = $signing.KEY_ALIAS
$env:AMB_ANDROID_KEY_PASSWORD = $signing.KEY_PASSWORD

$resolvedLanServerUrl = Resolve-LanServerUrl
$resolvedServerUrl = Resolve-DefaultServerUrl $resolvedLanServerUrl
$gradle = Join-Path $GradleRoot "bin\gradle.bat"
Push-Location $AndroidProject
try {
  if (-not (Test-Path -LiteralPath (Join-Path $AndroidProject "gradlew.bat"))) {
    & $gradle wrapper --gradle-version 9.3.1 --distribution-type bin
    if ($LASTEXITCODE -ne 0) { throw "Gradle wrapper generation failed" }
  }

  Write-Host "Building Android release for remote server $resolvedServerUrl"
  Write-Host "LAN fallback: $resolvedLanServerUrl"
  & $gradle clean testDebugUnitTest lintRelease assembleRelease `
    "-PdefaultServerUrl=$resolvedServerUrl" `
    "-PlanServerUrl=$resolvedLanServerUrl" `
    --stacktrace
  if ($LASTEXITCODE -ne 0) { throw "Android release build failed" }
} finally {
  Pop-Location
}

$builtApk = Join-Path $AndroidProject "app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path -LiteralPath $builtApk)) { throw "Release APK was not produced: $builtApk" }

$apkSigner = Join-Path $SdkRoot "build-tools\36.0.0\apksigner.bat"
& $apkSigner verify --verbose --print-certs $builtApk
if ($LASTEXITCODE -ne 0) { throw "APK signature verification failed" }

Copy-Item -LiteralPath $builtApk -Destination $OutputApk -Force
$hash = Get-FileHash -LiteralPath $OutputApk -Algorithm SHA256
"$($hash.Hash.ToLowerInvariant())  $(Split-Path $OutputApk -Leaf)" | Set-Content -LiteralPath $OutputHash -Encoding ASCII
$sourceFiles = Get-ChildItem -LiteralPath $AndroidProject -Recurse -File | Where-Object {
  $_.FullName -notlike "*\build\*" -and $_.FullName -notlike "*\.gradle\*" -and
    $_.Name -notin @("local.properties", ".signing.env")
} | Sort-Object FullName
$sourceFingerprintText = ($sourceFiles | ForEach-Object {
  $relative = $_.FullName.Substring($AndroidProject.Length + 1).Replace("\", "/")
  "$relative $((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())"
}) -join "`n"
$sourceFingerprintBytes = [Text.Encoding]::UTF8.GetBytes($sourceFingerprintText)
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $sourceFingerprint = ([BitConverter]::ToString($sha256.ComputeHash($sourceFingerprintBytes))).Replace("-", "").ToLowerInvariant()
} finally {
  $sha256.Dispose()
}
$signerOutput = (& $apkSigner verify --print-certs $OutputApk 2>&1 | Out-String)
$signerDigest = [regex]::Match($signerOutput, "Signer #1 certificate SHA-256 digest:\s*([a-fA-F0-9]+)").Groups[1].Value.ToLowerInvariant()
$aapt = Join-Path $SdkRoot "build-tools\36.0.0\aapt.exe"
$badgingOutput = (& $aapt dump badging $OutputApk 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw "APK manifest inspection failed" }
$packageMatch = [regex]::Match($badgingOutput, "package:\s+name='[^']+'\s+versionCode='([^']+)'\s+versionName='([^']+)'")
if (-not $packageMatch.Success) { throw "APK version metadata could not be read from the built manifest" }
$versionCode = [int]$packageMatch.Groups[1].Value
$versionName = $packageMatch.Groups[2].Value
[ordered]@{
  artifact = Split-Path $OutputApk -Leaf
  sha256 = $hash.Hash.ToLowerInvariant()
  sourceFingerprintSha256 = $sourceFingerprint
  signerCertificateSha256 = $signerDigest
  versionName = $versionName
  versionCode = $versionCode
  defaultServerUrl = $resolvedServerUrl
  builtAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json | Set-Content -LiteralPath $OutputManifest -Encoding UTF8

$apk = Get-Item -LiteralPath $OutputApk
Write-Host ""
Write-Host "Android APK ready: $($apk.FullName)"
Write-Host "Size: $([math]::Round($apk.Length / 1MB, 2)) MB"
Write-Host "SHA-256: $($hash.Hash.ToLowerInvariant())"
