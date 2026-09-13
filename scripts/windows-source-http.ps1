param([switch]$AllowLoopbackTest)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

while ($null -ne ($line = [Console]::ReadLine())) {
  $response = $null
  $stream = $null
  $memory = $null
  try {
    $inputRequest = $line | ConvertFrom-Json
    $uri = [Uri]$inputRequest.url
    $testAllowed = $AllowLoopbackTest -and $uri.IsLoopback -and $env:AMB_PIPELINE_INTEGRATION_TEST -eq '1'
    if (!$testAllowed -and ($uri.Scheme -ne 'https' -or $uri.DnsSafeHost -ne 'www.olx.ua' -or !$uri.IsDefaultPort -or $uri.UserInfo)) {
      throw 'Unsupported source transport URL'
    }
    $maxBytes = [Math]::Min(10000000, [Math]::Max(1, [int]$inputRequest.maxBytes))
    $request = [Net.HttpWebRequest]::CreateHttp($uri)
    $request.Method = 'GET'
    $request.AllowAutoRedirect = $false
    $request.KeepAlive = $true
    $request.AutomaticDecompression = [Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
    $request.Timeout = [Math]::Min(60000, [Math]::Max(100, [int]$inputRequest.timeoutMs))
    $request.ReadWriteTimeout = $request.Timeout
    foreach ($header in $inputRequest.headers.PSObject.Properties) {
      switch ($header.Name.ToLowerInvariant()) {
        'user-agent' { $request.UserAgent = [string]$header.Value }
        'accept' { $request.Accept = [string]$header.Value }
        'referer' { $request.Referer = [string]$header.Value }
        default { $request.Headers.Add($header.Name, [string]$header.Value) }
      }
    }
    try { $response = $request.GetResponse() }
    catch [Net.WebException] {
      if (!$_.Exception.Response) { throw }
      $response = $_.Exception.Response
    }
    $headersAt = [DateTime]::UtcNow.ToString('o')
    $responseHeaders = @{}
    foreach ($name in @('Content-Type','Retry-After','Age','Location','Server','cf-mitigated')) {
      if ($response.Headers[$name]) { $responseHeaders[$name] = [string]$response.Headers[$name] }
    }
    $oversized = $response.ContentLength -gt $maxBytes
    $memory = [IO.MemoryStream]::new()
    if (!$oversized) {
      $stream = $response.GetResponseStream()
      $buffer = New-Object byte[] 32768
      while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        if (($memory.Length + $count) -gt $maxBytes) { $oversized = $true; break }
        $memory.Write($buffer, 0, $count)
      }
    }
    $bodyAt = [DateTime]::UtcNow.ToString('o')
    $responseHeaders['Content-Length'] = if ($oversized) { [string]($maxBytes + 1) } else { [string]$memory.Length }
    $body = if ($oversized) { '' } else { [Convert]::ToBase64String($memory.ToArray()) }
    $result = @{ id=$inputRequest.id; status=[int]$response.StatusCode; headers=$responseHeaders; body=$body; headersAt=$headersAt; bodyAt=$bodyAt }
  } catch {
    $result = @{ id=$inputRequest.id; error='Windows source HTTP request failed'; errorKind=$_.Exception.GetType().Name }
  } finally {
    if ($stream) { $stream.Dispose() }
    if ($response) { $response.Dispose() }
    if ($memory) { $memory.Dispose() }
  }
  [Console]::WriteLine(($result | ConvertTo-Json -Compress -Depth 5))
}
