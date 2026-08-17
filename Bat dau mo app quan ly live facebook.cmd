@echo off
rem ==========================================================================
rem  Facebook Live Manager - double-click this file to open the app.
rem
rem  This file is intentionally ASCII-only. cmd.exe parses batch files
rem  byte-by-byte, and multi-byte UTF-8 characters (Vietnamese diacritics)
rem  corrupt its line boundaries and make the script unrunnable. All of the
rem  real logic and all Vietnamese text live in scripts\launch.js instead.
rem ==========================================================================

rem UTF-8 so Node's Vietnamese output renders correctly in this window.
chcp 65001 >nul 2>nul
setlocal
cd /d "%~dp0"
title Facebook Live Manager

rem Prefer the bundled runtime, so the app works on a machine with no Node.js
rem installed. Falls back to a system Node when the runtime was not shipped.
if exist "runtime\node.exe" (
  "runtime\node.exe" "scripts\launch.js"
  if errorlevel 1 goto failed
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 goto no_node

node "scripts\launch.js"
if errorlevel 1 goto failed
exit /b 0

:no_node
echo.
echo   ==========================================================
echo      NODE.JS IS NOT INSTALLED
echo.
echo      This copy was packaged without the bundled runtime,
echo      so it needs Node.js installed.
echo.
echo      1. Press any key - the download page will open
echo      2. Download the "LTS" version, install it normally
echo         (Next - Next - Finish)
echo      3. Then double-click this file again
echo.
echo      May nay chua co Node.js. Bam mot phim de mo trang tai,
echo      tai ban LTS, cai binh thuong, roi bam doi lai file nay.
echo   ==========================================================
echo.
pause >nul
start "" "https://nodejs.org/en/download"
exit /b 1

:failed
echo.
pause
exit /b 1
