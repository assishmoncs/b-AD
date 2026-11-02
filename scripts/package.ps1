$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$version = (Get-Content -LiteralPath (Join-Path $workspace 'manifest.json') -Raw | ConvertFrom-Json).version
$releaseDirectory = Join-Path $workspace 'release'
New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
$archive = Join-Path $releaseDirectory "b-ad-ultra-$version.zip"

$runtimeFiles = @(
  'manifest.json', 'background.js', 'content.js', 'detector_scan.js',
  'stealth_mode.js', 'youtube_engine.js', 'zapper.js',
  'popup.html', 'popup.css', 'popup.js',
  'options.html', 'options.css', 'options.js',
  'rules.json', 'tracking_rules.json', 'LICENSE', 'icons'
)
$paths = $runtimeFiles | ForEach-Object { Join-Path $workspace $_ }
foreach ($item in $paths) {
  if (-not (Test-Path -LiteralPath $item)) { throw "Missing release file: $item" }
}
Compress-Archive -LiteralPath $paths -DestinationPath $archive -Force

Add-Type -AssemblyName System.IO.Compression
$zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
try {
  $names = @($zip.Entries | ForEach-Object FullName)
  if ('manifest.json' -notin $names -or 'tracking_rules.json' -notin $names -or 'icons/icon128.png' -notin $names) {
    throw 'Release archive is missing required files.'
  }
} finally {
  $zip.Dispose()
}
Write-Output $archive
