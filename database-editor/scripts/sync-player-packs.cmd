@echo off
setlocal
cd /d "%~dp0\..\.."
node database-editor\scripts\sync-player-packs.mjs
if errorlevel 1 pause
