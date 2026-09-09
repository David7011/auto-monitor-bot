$ErrorActionPreference = "Stop"
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$LogRoot = Join-Path $ProjectRoot ".runtime\logs"
$LogPath = Join-Path $LogRoot "autostart-security-repair.log"
[IO.Directory]::CreateDirectory($LogRoot) | Out-Null

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Autostart security repair requires an elevated Administrator shell"
}

try {
  & (Join-Path $PSScriptRoot "install-autostart.ps1")
  [IO.File]::WriteAllText($LogPath, "PASS $((Get-Date).ToString('o'))`r`n", [Text.UTF8Encoding]::new($false))
} catch {
  $safeDiagnostic = "FAIL $((Get-Date).ToString('o'))`r`n$($_.Exception.ToString())`r`n"
  [IO.File]::WriteAllText($LogPath, $safeDiagnostic, [Text.UTF8Encoding]::new($false))
  throw
}
