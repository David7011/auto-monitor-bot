@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0.."
set "PROJECT_ROOT=%CD%"
set "BACKUP_ROOT=%~dp0..\..\AutoMonitorBotSecurityBackups"
set "PROJECT_PARENT=%~dp0..\.."

net session >nul 2>&1
if errorlevel 1 (
  echo Runtime ACL hardening requires an elevated Administrator shell. 1>&2
  exit /b 1
)

for /f "tokens=2 delims=," %%S in ('whoami /user /fo csv /nh') do set "OWNER_SID=%%~S"
if not defined OWNER_SID (
  echo Could not resolve the trusted project owner SID. 1>&2
  exit /b 1
)

if not exist "%BACKUP_ROOT%" mkdir "%BACKUP_ROOT%"
set "RUN_ID=%RANDOM%-%RANDOM%"
set "ACL_BACKUP=%BACKUP_ROOT%\root-acl-before-%RUN_ID%.txt"
set "TEMPLATE_ROOT=%BACKUP_ROOT%\acl-template-%RUN_ID%"
set "TEMPLATE_PROJECT=%TEMPLATE_ROOT%\auto-monitor-bot"
set "SAFE_ACL=%TEMPLATE_ROOT%\safe-acl.txt"
"%SystemRoot%\System32\icacls.exe" "%PROJECT_ROOT%" /save "%ACL_BACKUP%" /L /Q
if errorlevel 1 (
  echo Could not save the root ACL backup. 1>&2
  exit /b 1
)

mkdir "%TEMPLATE_PROJECT%"
"%SystemRoot%\System32\icacls.exe" "%TEMPLATE_PROJECT%" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *%OWNER_SID%:(OI)(CI)F /Q
if errorlevel 1 exit /b 1
"%SystemRoot%\System32\icacls.exe" "%TEMPLATE_PROJECT%" /setowner *S-1-5-32-544 /Q
if errorlevel 1 exit /b 1
"%SystemRoot%\System32\icacls.exe" "%TEMPLATE_PROJECT%" /save "%SAFE_ACL%" /L /Q
if errorlevel 1 exit /b 1
"%SystemRoot%\System32\icacls.exe" "%PROJECT_PARENT%" /restore "%SAFE_ACL%" /C /Q
if errorlevel 1 (
  echo Could not apply the exact safe root ACL. Restore the saved ACL if required: %ACL_BACKUP% 1>&2
  exit /b 1
)

rem Remove descendant-specific grants and make every object inherit the safe root.
rem /L operates on reparse points instead of traversing external package stores.
"%SystemRoot%\System32\icacls.exe" "%PROJECT_ROOT%\*" /reset /T /C /L /Q
if errorlevel 1 (
  echo Could not normalize descendant ACLs. Restore the saved ACL if required: %ACL_BACKUP% 1>&2
  exit /b 1
)
"%SystemRoot%\System32\icacls.exe" "%PROJECT_ROOT%\*" /setowner *S-1-5-32-544 /T /C /L /Q
if errorlevel 1 (
  echo Could not normalize descendant owners. Restore the saved ACL if required: %ACL_BACKUP% 1>&2
  exit /b 1
)

rem Re-apply defense-in-depth boundaries after the recursive inheritance reset.
if not exist "%PROJECT_ROOT%\.runtime\security" mkdir "%PROJECT_ROOT%\.runtime\security"
>"%PROJECT_ROOT%\.runtime\security\acl-policy.conf" echo version=1
>>"%PROJECT_ROOT%\.runtime\security\acl-policy.conf" echo projectRoot=%PROJECT_ROOT%
>>"%PROJECT_ROOT%\.runtime\security\acl-policy.conf" echo ownerSid=%OWNER_SID%
>>"%PROJECT_ROOT%\.runtime\security\acl-policy.conf" echo allowedWriterSids=S-1-5-18,S-1-5-32-544,%OWNER_SID%

"%SystemRoot%\System32\icacls.exe" "%PROJECT_ROOT%\scripts" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*%OWNER_SID%:(OI)(CI)F" /Q
if errorlevel 1 exit /b 1
"%SystemRoot%\System32\icacls.exe" "%PROJECT_ROOT%\scripts" /setowner *S-1-5-32-544 /Q
if errorlevel 1 exit /b 1
"%SystemRoot%\System32\icacls.exe" "%PROJECT_ROOT%\.runtime\security" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*%OWNER_SID%:(OI)(CI)F" /Q
if errorlevel 1 exit /b 1
"%SystemRoot%\System32\icacls.exe" "%PROJECT_ROOT%\.runtime\security" /setowner *S-1-5-32-544 /Q
if errorlevel 1 exit /b 1
"%SystemRoot%\System32\icacls.exe" "%PROJECT_ROOT%\.env" /inheritance:r /grant:r "*S-1-5-18:F" "*S-1-5-32-544:F" "*%OWNER_SID%:F" /Q
if errorlevel 1 exit /b 1
"%SystemRoot%\System32\icacls.exe" "%PROJECT_ROOT%\.env" /setowner *S-1-5-32-544 /Q
if errorlevel 1 exit /b 1

call "%~dp0security-check.cmd"
if errorlevel 1 exit /b %errorlevel%

echo Runtime ACL hardening passed.
echo Trusted owner SID: %OWNER_SID%
echo Root ACL backup: %ACL_BACKUP%
exit /b 0
