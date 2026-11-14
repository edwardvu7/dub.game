@echo off
rem dub.game for the team: double-click to install everything (first time) and start the app.
cd /d "%~dp0"
title dub.game

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Opening the download page: install the LTS version,
  echo then double-click start.bat again.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)

node -e "process.exit(+process.versions.node.split('.')[0] < 20 ? 1 : 0)"
if errorlevel 1 (
  echo Your Node.js is older than version 20. Install the LTS version from nodejs.org, then try again.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)

rem Install when packages are missing or package-lock.json changed since the last install.
set NEED_INSTALL=0
if not exist node_modules\electron set NEED_INSTALL=1
if not exist node_modules\.dubgame-installed.lock set NEED_INSTALL=1
if exist package-lock.json if exist node_modules\.dubgame-installed.lock (
  fc /b package-lock.json node_modules\.dubgame-installed.lock >nul 2>nul || set NEED_INSTALL=1
)
if "%NEED_INSTALL%"=="1" (
  echo Installing dub.game. The first time takes a few minutes...
  call npm install
  if errorlevel 1 (
    echo.
    echo The install failed. Copy the messages above and send them to the team.
    pause
    exit /b 1
  )
  copy /y package-lock.json node_modules\.dubgame-installed.lock >nul
)

echo Starting dub.game. Keep this window open while you use the app.
call npm start
if errorlevel 1 pause
