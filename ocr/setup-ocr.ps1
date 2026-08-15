# FlatNotes Textify - one-time OCR engine setup.
# Downloads llama.cpp (Windows ARM64 CPU build) into %LOCALAPPDATA%\FlatNotes\ocr\llama.
# The GLM-OCR model (~1 GB) is downloaded automatically the first time the engine starts.

$ErrorActionPreference = 'Stop'
$dir = "$env:LOCALAPPDATA\FlatNotes\ocr"
New-Item -ItemType Directory -Force $dir | Out-Null

if (Test-Path "$dir\llama\llama-server.exe") {
    Write-Host "OCR engine already installed at $dir\llama" -ForegroundColor Green
    exit 0
}

Write-Host "Fetching latest llama.cpp Windows ARM64 build..."
$rel = Invoke-RestMethod "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
$asset = $rel.assets | Where-Object { $_.name -match 'bin-win-cpu-arm64\.zip$' } | Select-Object -First 1
if (-not $asset) { throw "No win-cpu-arm64 asset found in latest release." }

$zip = "$dir\llama.zip"
Invoke-WebRequest $asset.browser_download_url -OutFile $zip
Expand-Archive $zip -DestinationPath "$dir\llama" -Force
Remove-Item $zip

Write-Host "Installed $($asset.name) to $dir\llama" -ForegroundColor Green
Write-Host "Done. FlatNotes will start the engine (and fetch the GLM-OCR model once, ~1 GB) the first time you use Textify."
