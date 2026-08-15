# Update the installed FlatNotes without replacing FlatNotes.exe.
#
# Why this exists: a full reinstall (robocopy /MIR of the packaged output) deletes and
# recreates FlatNotes.exe. Windows Start and taskbar pins point at that exact file, so
# recreating it silently drops the pin. All of our own code lives in resources\app.asar,
# so updating just that file keeps the exe, and the pin, untouched.
#
# Use a full `npm run dist` + reinstall only when Electron itself is upgraded.

param(
    [string]$Install = "$env:LOCALAPPDATA\Programs\FlatNotes"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$asarLib = Join-Path $root 'node_modules\@electron\asar'
$target = Join-Path $Install 'resources\app.asar'

if (-not (Test-Path $asarLib)) { Write-Host "Missing @electron/asar, run npm install first." -ForegroundColor Yellow; exit 1 }
if (-not (Test-Path $target)) { Write-Host "FlatNotes is not installed at $Install" -ForegroundColor Yellow; exit 1 }

Get-Process FlatNotes -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

$stage = Join-Path $env:TEMP ('flatnotes-pack-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item (Join-Path $root 'app') $stage -Recurse
Copy-Item (Join-Path $root 'electron') $stage -Recurse
Copy-Item (Join-Path $root 'package.json') $stage

$out = Join-Path $stage 'app.asar'
$script = @"
const asar = require(process.argv[2]);
asar.createPackage(process.argv[3], process.argv[4]).then(() => console.log('packed'));
"@
$scriptFile = Join-Path $stage 'pack.cjs'
Set-Content -Path $scriptFile -Value $script -Encoding utf8

$src = Join-Path $stage 'staged'
New-Item -ItemType Directory -Force -Path $src | Out-Null
Move-Item (Join-Path $stage 'app') $src
Move-Item (Join-Path $stage 'electron') $src
Move-Item (Join-Path $stage 'package.json') $src

node $scriptFile $asarLib $src $out
if (-not (Test-Path $out)) { Write-Host "Packing failed." -ForegroundColor Red; exit 1 }

# keep one rollback copy next to the installed archive
Copy-Item $target "$target.bak" -Force
Copy-Item $out $target -Force
Remove-Item $stage -Recurse -Force

Write-Host "Updated $target (exe untouched, pin preserved)." -ForegroundColor Green
Write-Host "Rollback: copy `"$target.bak`" over `"$target`"."
