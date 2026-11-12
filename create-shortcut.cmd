@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcut.ps1"
if errorlevel 1 (
  echo.
  echo Failed to create the desktop shortcut.
  pause
  exit /b 1
)
echo.
echo Travnik shortcut is ready on the desktop.
pause
