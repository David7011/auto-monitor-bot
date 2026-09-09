function ConvertTo-BackupCryptoArgument {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Argument)

  if ($Argument.Contains('"') -or $Argument.Contains([char]0) -or
      $Argument.Contains("`r") -or $Argument.Contains("`n")) {
    throw "Backup crypto arguments must not contain quotes or control characters"
  }
  if ($Argument.Length -gt 0 -and $Argument -notmatch '\s') { return $Argument }
  $quotedArgument = $Argument -replace '(\\+)$', '$1$1'
  return '"' + $quotedArgument + '"'
}

function Invoke-BackupCrypto {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][ValidateSet("encrypt", "decrypt")][string]$Operation,
    [Parameter(Mandatory = $true)][string]$InputPath,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][string]$Password
  )

  $projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
  $nodePath = Join-Path $projectRoot ".runtime\node-runtime-v2\node-v24.18.0-win-x64\node.exe"
  $cryptoScript = Join-Path $PSScriptRoot "backup-crypto.mjs"
  if (!(Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw "Pinned Node.js runtime is missing" }
  if (!(Test-Path -LiteralPath $cryptoScript -PathType Leaf)) { throw "Backup crypto helper is missing" }
  if ($Password.Length -lt 32) { throw "Backup encryption password must contain at least 32 characters" }

  $arguments = @($cryptoScript, $Operation, $InputPath, $OutputPath)
  foreach ($argument in $arguments) {
    if ($argument.Contains($Password)) { throw "Refusing to place the backup password in process arguments" }
  }

  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $nodePath
  $startInfo.Arguments = ($arguments | ForEach-Object { ConvertTo-BackupCryptoArgument $_ }) -join ' '
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $startInfo
  $started = $false
  $passwordForRedaction = $Password
  try {
    if (!$process.Start()) { throw "Backup crypto process could not start" }
    $started = $true
    $process.StandardInput.NewLine = "`n"
    $process.StandardInput.WriteLine($Password)
    $process.StandardInput.Close()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $Password = $null
    $diagnostic = (($stderrTask.Result + "`n" + $stdoutTask.Result).Trim() -replace '[\r\n]+', ' ')
    $diagnostic = $diagnostic.Replace($passwordForRedaction, '[REDACTED]')
    if ($process.ExitCode -ne 0) {
      if ($diagnostic.Length -gt 600) { $diagnostic = $diagnostic.Substring(0, 600) }
      if ($diagnostic) { throw "Backup $Operation failed with exit code $($process.ExitCode): $diagnostic" }
      throw "Backup $Operation failed with exit code $($process.ExitCode)"
    }
  } finally {
    $Password = $null
    $passwordForRedaction = $null
    if ($started -and !$process.HasExited) { $process.Kill() }
    $process.Dispose()
  }
}
