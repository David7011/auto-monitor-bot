$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$AndroidProject = Join-Path $ProjectRoot "apps\mobile-android"
$RuntimeRoot = Join-Path $ProjectRoot ".runtime\android"

if (Test-Path -LiteralPath (Join-Path $RuntimeRoot "jdk-17\bin\java.exe")) {
  $env:JAVA_HOME = Join-Path $RuntimeRoot "jdk-17"
}
if (Test-Path -LiteralPath (Join-Path $RuntimeRoot "sdk")) {
  $env:ANDROID_HOME = Join-Path $RuntimeRoot "sdk"
  $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
}
$env:GRADLE_USER_HOME = Join-Path $RuntimeRoot "gradle-home"

if (!$env:JAVA_HOME -or !(Test-Path -LiteralPath (Join-Path $env:JAVA_HOME "bin\java.exe"))) {
  throw "JAVA_HOME does not point to a usable JDK"
}
if (!$env:ANDROID_HOME -or !(Test-Path -LiteralPath $env:ANDROID_HOME)) {
  throw "ANDROID_HOME does not point to an Android SDK"
}

Push-Location $AndroidProject
try {
  & (Join-Path $AndroidProject "gradlew.bat") testDebugUnitTest lintRelease --no-daemon
  if ($LASTEXITCODE -ne 0) { throw "Android unit tests or release lint failed" }
} finally {
  Pop-Location
}
