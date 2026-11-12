@echo off
chcp 65001 >nul
title Travnik
cd /d "%~dp0"

set "TRAVNIK_NODE=%~dp0tools\node\node.exe"
if not exist "%TRAVNIK_NODE%" set "TRAVNIK_NODE=node"

echo Starting Travnik...
"%TRAVNIK_NODE%" --disable-warning=ExperimentalWarning app\server.mjs --open
if errorlevel 1 (
  echo.
  echo Failed to start the application.
  echo Run install.cmd first, then try again.
  pause
)