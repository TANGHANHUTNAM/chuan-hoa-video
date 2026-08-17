@echo off
rem ==========================================================================
rem  Chuan Hoa Video - double-click this file.
rem
rem  Sits at the top of the folder, next to "Facebook Live Manager.cmd", so
rem  somebody who does not write code sees both apps and both video folders
rem  immediately after unzipping - no hunting inside a folder full of code.
rem
rem  ASCII-only on purpose: cmd.exe parses batch files byte-by-byte, and
rem  multi-byte UTF-8 (Vietnamese diacritics) corrupts its line boundaries and
rem  makes the script unrunnable. All Vietnamese text lives in app.js.
rem
rem  Independent of the Live Manager app: no shared code, no shared database,
rem  different port. Both can run at the same time.
rem ==========================================================================

chcp 65001 >nul 2>nul
setlocal
cd /d "%~dp0"
title Chuan Hoa Video

if not exist "chuan-hoa-video\app.js" goto missing

rem The bundled runtime first, so this works on a machine with no Node.js.
if exist "runtime\node.exe" (
  "runtime\node.exe" "chuan-hoa-video\app.js"
  goto done
)

where node >nul 2>nul
if errorlevel 1 goto no_node
node "chuan-hoa-video\app.js"

:done
if errorlevel 1 goto failed
exit /b 0

:missing
echo.
echo   ==========================================================
echo      THIEU FILE chuan-hoa-video\app.js
echo.
echo      File nay phai nam cung thu muc voi thu muc
echo      "chuan-hoa-video". Hay giai nen lai toan bo folder.
echo   ==========================================================
echo.
pause >nul
exit /b 1

:no_node
echo.
echo   ==========================================================
echo      NODE.JS IS NOT INSTALLED
echo.
echo      1. Press any key - the download page will open
echo      2. Download the "LTS" version, install normally
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
