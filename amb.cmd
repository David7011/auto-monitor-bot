@echo off
setlocal
set "NODE_HOME=%~dp0.runtime\node-runtime-v2\node-v24.18.0-win-x64"
set "PNPM_HOME=%~dp0.runtime\node-runtime-v2\pnpm-10.0.0"

if not exist "%NODE_HOME%\node.exe" goto bootstrap
if not exist "%PNPM_HOME%\pnpm.cmd" goto bootstrap
goto run

:bootstrap
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ensure-node-runtime.ps1" >nul
if errorlevel 1 exit /b %ERRORLEVEL%

:run
set "PATH=%NODE_HOME%;%PNPM_HOME%;%PATH%"
call "%PNPM_HOME%\pnpm.cmd" %*
exit /b %ERRORLEVEL%
