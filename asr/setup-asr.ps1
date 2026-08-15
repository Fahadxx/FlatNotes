# FlatNotes Voice - one-time speech recognition engine setup.
# Downloads sherpa-onnx (Windows ARM64 CPU build) into %LOCALAPPDATA%\FlatNotes\asr\bin
# and the Parakeet TDT 0.6B v2 model into %LOCALAPPDATA%\FlatNotes\asr\models.
#
# Unlike the OCR engine, sherpa-onnx cannot fetch its own weights, so the model
# (~480 MB) is downloaded here rather than on first use.

# Pass -Model sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 for the multilingual model.
param(
    [string]$Version = 'v1.13.4',
    [string]$Model = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8'
)

$ErrorActionPreference = 'Stop'
$dir = "$env:LOCALAPPDATA\FlatNotes\asr"
New-Item -ItemType Directory -Force $dir | Out-Null
New-Item -ItemType Directory -Force "$dir\models" | Out-Null

# The sherpa-onnx "latest" release is a model drop, not a code release, so the
# runtime version is pinned rather than resolved through /releases/latest.
$pkg = "sherpa-onnx-$Version-win-arm64-shared-MD-Release"

if (Test-Path "$dir\bin\sherpa-onnx-offline-websocket-server.exe") {
    Write-Host "Voice engine already installed at $dir\bin" -ForegroundColor Green
}
else {
    Write-Host "Fetching sherpa-onnx $Version (win-arm64 CPU build)..."
    $url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/$Version/$pkg.tar.bz2"
    $tar = "$dir\sherpa.tar.bz2"
    Invoke-WebRequest $url -OutFile $tar
    tar -xjf $tar -C $dir
    if ($LASTEXITCODE -ne 0) { throw "Failed to extract $tar" }

    # Flatten to asr\bin so the layout matches the OCR engine's asr-style llama folder.
    New-Item -ItemType Directory -Force "$dir\bin" | Out-Null
    Copy-Item "$dir\$pkg\bin\*" "$dir\bin" -Force
    Copy-Item "$dir\$pkg\lib\*.dll" "$dir\bin" -Force
    Remove-Item "$dir\$pkg" -Recurse -Force
    Remove-Item $tar
    Write-Host "Installed $pkg to $dir\bin" -ForegroundColor Green
}

if (Test-Path "$dir\models\$Model\encoder.int8.onnx") {
    Write-Host "Model $Model already present" -ForegroundColor Green
}
else {
    Write-Host "Fetching $Model (~480 MB, this takes a few minutes)..."
    $url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$Model.tar.bz2"
    $tar = "$dir\model.tar.bz2"
    Invoke-WebRequest $url -OutFile $tar
    tar -xjf $tar -C "$dir\models"
    if ($LASTEXITCODE -ne 0) { throw "Failed to extract $tar" }
    Remove-Item $tar
    Write-Host "Installed $Model to $dir\models" -ForegroundColor Green
}

Write-Host "Done. FlatNotes starts the voice engine on demand the first time you use the Voice tool."
