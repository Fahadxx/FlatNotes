# FlatNotes Voice - start the local speech recognition engine manually (only needed when
# using FlatNotes in a browser; the desktop app starts/stops it automatically).
#
# Usage:  .\start-asr-engine.ps1                      (Parakeet TDT 0.6B v2, the default)
#         .\start-asr-engine.ps1 parakeet-tdt-0.6b-v3
#
# Pick the matching model in the Voice tool popover.

param([string]$Model = 'parakeet-tdt-0.6b-v2')

$dir = "$env:LOCALAPPDATA\FlatNotes\asr"
$exe = "$dir\bin\sherpa-onnx-offline-websocket-server.exe"
if (-not (Test-Path $exe)) {
    Write-Host "Engine not installed - run setup-asr.ps1 first." -ForegroundColor Yellow
    exit 1
}

$defs = @{
    'parakeet-tdt-0.6b-v2' = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8'
    'parakeet-tdt-0.6b-v3' = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
}

if (-not $defs.ContainsKey($Model)) {
    Write-Host "Unknown model '$Model'. Options: $($defs.Keys -join ', ')" -ForegroundColor Yellow
    exit 1
}

$m = "$dir\models\$($defs[$Model])"
foreach ($f in @('encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt')) {
    if (-not (Test-Path "$m\$f")) { Write-Host "Missing model file: $m\$f" -ForegroundColor Red; exit 1 }
}

# One utterance at a time: the live transcript re-decodes its growing buffer, so batching
# would only add latency to the request that is actually on screen.
# sherpa-onnx parses only the --key=value form; a space separated value is read as empty.
& $exe "--port=8091" "--num-io-threads=1" "--num-work-threads=2" "--max-batch-size=1" `
    "--log-file=$dir\server.log" `
    "--encoder=$m\encoder.int8.onnx" "--decoder=$m\decoder.int8.onnx" `
    "--joiner=$m\joiner.int8.onnx" "--tokens=$m\tokens.txt" "--num-threads=6"
