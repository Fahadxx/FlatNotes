# FlatNotes Textify - start the local OCR engine manually (only needed when using
# FlatNotes in a browser; the desktop app starts/stops it automatically).
#
# Usage:  .\start-ocr-engine.ps1            (GLM-OCR, the default)
#         .\start-ocr-engine.ps1 gemma-4-e4b
#         .\start-ocr-engine.ps1 qwen35-4b
#         .\start-ocr-engine.ps1 qwen35-08b
#
# Pick the matching model in the Textify tool popover so the right prompt is used.

param([string]$Model = 'glm-ocr')

$exe = "$env:LOCALAPPDATA\FlatNotes\ocr\llama\llama-server.exe"
if (-not (Test-Path $exe)) {
    Write-Host "Engine not installed - run setup-ocr.ps1 first." -ForegroundColor Yellow
    exit 1
}

$lm = "$env:USERPROFILE\.cache\lm-studio\models\lmstudio-community"
$defs = @{
    'glm-ocr'     = @{ Hf = 'ggml-org/GLM-OCR-GGUF:Q8_0' }
    'gemma-4-e4b' = @{ M = "$lm\gemma-4-E4B-it-GGUF\gemma-4-E4B-it-Q4_K_M.gguf"; MM = "$lm\gemma-4-E4B-it-GGUF\mmproj-gemma-4-E4B-it-BF16.gguf" }
    'qwen35-4b'   = @{ M = "$lm\Qwen3.5-4B-GGUF\Qwen3.5-4B-Q4_K_M.gguf"; MM = "$lm\Qwen3.5-4B-GGUF\mmproj-Qwen3.5-4B-BF16.gguf" }
    'qwen35-08b'  = @{ M = "$lm\Qwen3.5-0.8B-GGUF\Qwen3.5-0.8B-Q8_0.gguf"; MM = "$lm\Qwen3.5-0.8B-GGUF\mmproj-Qwen3.5-0.8B-BF16.gguf" }
}

if (-not $defs.ContainsKey($Model)) {
    Write-Host "Unknown model '$Model'. Options: $($defs.Keys -join ', ')" -ForegroundColor Yellow
    exit 1
}

$d = $defs[$Model]
# -c 8192 --parallel 1 keeps the KV cache small; the default would reserve many GB.
if ($d.Hf) {
    & $exe -hf $d.Hf --port 8090 --host 127.0.0.1 -c 8192 --parallel 1
}
else {
    foreach ($f in @($d.M, $d.MM)) {
        if (-not (Test-Path $f)) { Write-Host "Missing model file: $f" -ForegroundColor Red; exit 1 }
    }
    & $exe -m $d.M --mmproj $d.MM --port 8090 --host 127.0.0.1 -c 8192 --parallel 1
}
