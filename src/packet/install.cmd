@echo off
setlocal

set "_PS=%~dp0install.ps1"
set "_ARGS=%*"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%_PS%" %_ARGS%
set "_EC=%ERRORLEVEL%"

if "%~1"=="" pause
exit /b %_EC%
