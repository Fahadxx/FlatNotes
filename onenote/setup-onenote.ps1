# Build the FlatNotes OneNote exporter.
#
# The exporter is a small .NET Framework console binary compiled by the in-box csc.exe
# against the Microsoft.Office.Interop.OneNote PIA that Office already installed into the
# GAC. Nothing is downloaded and nothing is registered. Run this once:
#
#   powershell -ExecutionPolicy Bypass -File onenote\setup-onenote.ps1
#
# onenote\setup-onenote.cmd does exactly the same thing without PowerShell.
#
# Output: %LOCALAPPDATA%\FlatNotes\onenote\bin\FlatNotesOneNote.exe, which is where the
# OCR and voice engines live too, so the packaged app finds it the same way.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $here 'FlatNotesOneNote.cs'
$bin  = Join-Path $env:LOCALAPPDATA 'FlatNotes\onenote\bin'
$exe  = Join-Path $bin 'FlatNotesOneNote.exe'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw "csc.exe not found. .NET Framework 4 is required." }

$gac = Join-Path $env:WINDIR 'assembly\GAC_MSIL\Microsoft.Office.Interop.OneNote'
if (-not (Test-Path $gac)) { throw "The OneNote interop assembly is not installed. Is OneNote 2016 present?" }
# One level only: recursing through %WINDIR%\assembly goes through the fusion shell
# extension and can take minutes.
$pia = $null
foreach ($d in ([System.IO.Directory]::GetDirectories($gac) | Sort-Object -Descending)) {
  $cand = Join-Path $d 'Microsoft.Office.Interop.OneNote.dll'
  if (Test-Path $cand) { $pia = $cand; break }
}
if (-not $pia) { throw "Microsoft.Office.Interop.OneNote.dll not found under $gac" }

$wpf = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\WPF'
if (-not (Test-Path (Join-Path $wpf 'PresentationCore.dll'))) {
  $wpf = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\WPF'
}

if (-not (Test-Path $bin)) { New-Item -ItemType Directory -Force $bin | Out-Null }

$refs = @(
  "/r:$pia",
  "/r:$(Join-Path $wpf 'PresentationCore.dll')",
  "/r:$(Join-Path $wpf 'WindowsBase.dll')",
  "/r:System.Xml.dll",
  "/r:System.Core.dll"
)

Write-Host "csc : $csc"
Write-Host "PIA : $pia"
Write-Host "WPF : $wpf"

& $csc /nologo /target:exe /platform:x64 /optimize+ "/out:$exe" @refs $src
if ($LASTEXITCODE -ne 0) { throw "compile failed with exit code $LASTEXITCODE" }

Write-Host ""
Write-Host "Built $exe"
Write-Host "Check it with:  & '$exe' list"
