@echo off
setlocal
cd /d "%~dp0"
echo KFM Database Studio - syncing browser player packs...
node database-editor\scripts\sync-player-packs.mjs
if errorlevel 1 (
  echo.
  echo Sync failed. Make sure Node.js is installed and assets\data\player_pack_catalog.json exists.
  pause
  exit /b 1
)
echo.
echo Done. You can now start Live Server / deploy the website.
pause
