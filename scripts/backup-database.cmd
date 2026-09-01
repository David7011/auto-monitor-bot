@echo off
call "%~dp0security-check.cmd" -Quiet
if errorlevel 1 exit /b %errorlevel%
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0backup-database.ps1"
exit /b %errorlevel%
