@echo off
rem Build the FlatNotes OneNote exporter without PowerShell.
rem Same job as setup-onenote.ps1: compile FlatNotesOneNote.cs with the in-box csc.exe
rem against the Microsoft.Office.Interop.OneNote PIA already in the GAC.
rem
rem   onenote\setup-onenote.cmd
rem
rem Output: %LOCALAPPDATA%\FlatNotes\onenote\bin\FlatNotesOneNote.exe

setlocal enabledelayedexpansion
set "HERE=%~dp0"
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" echo csc.exe not found, .NET Framework 4 is required & exit /b 1

set "WPF=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\WPF"
if not exist "%WPF%\PresentationCore.dll" set "WPF=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\WPF"

set "GAC=%WINDIR%\assembly\GAC_MSIL\Microsoft.Office.Interop.OneNote"
set "PIA="
for /f "delims=" %%d in ('dir /b /ad "%GAC%" 2^>nul') do (
  if exist "%GAC%\%%d\Microsoft.Office.Interop.OneNote.dll" set "PIA=%GAC%\%%d\Microsoft.Office.Interop.OneNote.dll"
)
if not defined PIA echo OneNote interop assembly not found, is OneNote 2016 installed? & exit /b 1

set "OUTDIR=%LOCALAPPDATA%\FlatNotes\onenote\bin"
if not exist "%OUTDIR%" mkdir "%OUTDIR%"

echo csc : %CSC%
echo PIA : %PIA%
echo WPF : %WPF%

"%CSC%" /nologo /target:exe /platform:x64 /optimize+ "/out:%OUTDIR%\FlatNotesOneNote.exe" "/r:%PIA%" "/r:%WPF%\PresentationCore.dll" "/r:%WPF%\WindowsBase.dll" /r:System.Xml.dll /r:System.Core.dll "%HERE%FlatNotesOneNote.cs"
if errorlevel 1 echo compile failed & exit /b 1

echo.
echo Built %OUTDIR%\FlatNotesOneNote.exe
echo Check it with:  "%OUTDIR%\FlatNotesOneNote.exe" list
