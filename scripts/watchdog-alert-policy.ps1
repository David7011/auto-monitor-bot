function ConvertFrom-AmbUtf8Base64([string]$Value) {
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

function Get-AmbWatchdogAlertText {
  return [pscustomobject]@{
    ProbeAfter = ConvertFrom-AmbUtf8Base64 "0YjRgtCw0YLQvdCw0Y8g0L/RgNC+0LLQtdGA0LrQsCDQv9C+0YHQu9C1"
    SourceProtection = ConvertFrom-AmbUtf8Base64 "QXV0byBNb25pdG9yIEJvdDog0LLQvdC10YjQvdGP0Y8g0LfQsNGJ0LjRgtCwINC40YHRgtC+0YfQvdC40LrQsCAoezB9KS4g0JvQvtC60LDQu9GM0L3Ri9C5IHJ1bnRpbWUg0LjRgdC/0YDQsNCy0LXQvS4g0JfQsNGJ0LjRgtC90LDRjyDQv9Cw0YPQt9CwINGB0L7RhdGA0LDQvdC10L3QsDsg0L/QvtCy0YLQvtGA0L3Ri9C1INGD0LLQtdC00L7QvNC70LXQvdC40Y8g0LTQviDQuNC30LzQtdC90LXQvdC40Y8g0YHQvtGB0YLQvtGP0L3QuNGPINC+0YLQutC70Y7Rh9C10L3Riy4="
    SourceProtectionCleared = ConvertFrom-AmbUtf8Base64 "QXV0byBNb25pdG9yIEJvdDog0LLQvdC10YjQvdGP0Y8g0LfQsNGJ0LjRgtCwINC40YHRgtC+0YfQvdC40LrQvtCyINGB0L3Rj9GC0LA7INGI0YLQsNGC0L3Ri9C1INC/0YDQvtCy0LXRgNC60Lgg0LLQvtGB0YHRgtCw0L3QvtCy0LvQtdC90Ysu"
    LocalFailure = ConvertFrom-AmbUtf8Base64 "QXV0byBNb25pdG9yIEJvdDog0LvQvtC60LDQu9GM0L3QsNGPINC+0YjQuNCx0LrQsCAjezB9ICh7MX0pLiBTdXBlcnZpc29yINC/0L7Qu9GD0YfQuNC7INC30LDQv9GA0L7RgSDQvdCwINCy0L7RgdGB0YLQsNC90L7QstC70LXQvdC40LUu"
  }
}

function Get-AmbSourceProtectionSnapshot($SourceHealth) {
  $text = Get-AmbWatchdogAlertText
  $states = [System.Collections.Generic.List[string]]::new()
  $details = [System.Collections.Generic.List[string]]::new()
  foreach ($source in @($SourceHealth)) {
    if ($source.sourceStatus -notin @("RATE_LIMITED", "CAPTCHA_DETECTED", "PAUSED")) { continue }
    $state = "$($source.source)=$($source.sourceStatus)"
    $states.Add($state)
    $pause = if ($source.pausedUntil) { ", $($text.ProbeAfter) $($source.pausedUntil)" } else { "" }
    $details.Add("$state$pause")
  }
  return [pscustomobject]@{
    Key = if ($states.Count -gt 0) { (@($states) | Sort-Object -Unique) -join "|" } else { $null }
    Details = @($details | Sort-Object)
  }
}

function ConvertTo-AmbCanonicalSourceProtectionKey([AllowNull()][string]$Value) {
  if (!$Value) { return "" }
  $states = [System.Collections.Generic.List[string]]::new()
  foreach ($match in [regex]::Matches($Value, '([A-Z][A-Z0-9_]*)=(RATE_LIMITED|CAPTCHA_DETECTED|PAUSED)')) {
    $states.Add("$($match.Groups[1].Value)=$($match.Groups[2].Value)")
  }
  if ($states.Count -eq 0) { return "" }
  return (@($states) | Sort-Object -Unique) -join "|"
}
