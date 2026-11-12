@echo off
chcp 65001 >nul
title Travnik Setup
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo Setup did not complete. Read the message above.
  pause
  exit /b 1
)
echo.
echo Done. Now run start.cmd
pause