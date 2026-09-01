@echo off
setlocal
cd /d "%~dp0.."
call "%~dp0security-check.cmd" -Quiet
if errorlevel 1 exit /b %errorlevel%
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0supervisor.ps1"
exit /b %errorlevel%
