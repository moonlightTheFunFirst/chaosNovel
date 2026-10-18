@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restart-server.ps1"
if errorlevel 1 (
  echo.
  echo Workers local server restart failed. See the message above.
  pause
  exit /b 1
)
endlocal
