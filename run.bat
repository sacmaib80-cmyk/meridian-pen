@echo off
REM ASCII only. cmd reads .bat with the ANSI codepage, so Thai in here would
REM arrive as garbage and be executed as commands.
title MERIDIAN ONE
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found in PATH.
  pause
  exit /b 1
)

echo   MERIDIAN ONE
echo   http://127.0.0.1:4180/
echo.
echo   KEEP THIS WINDOW OPEN. Closing it stops the site.
echo.
start "meridian-server" /min cmd /c "node scripts\serve.cjs 4180"

REM Poll the port instead of sleeping. timeout /t needs an interactive
REM console and fails silently when the window is minimised.
set /a TRIES=0
:WAIT
set /a TRIES+=1
curl -s -o nul http://127.0.0.1:4180/ >nul 2>&1
if not errorlevel 1 goto OPEN
if %TRIES% GEQ 40 goto OPEN
ping -n 2 127.0.0.1 >nul
goto WAIT

:OPEN
set "FF=%ProgramFiles%\Mozilla Firefox\firefox.exe"
if exist "%FF%" (start "" "%FF%" http://127.0.0.1:4180/) else (start "" http://127.0.0.1:4180/)

echo   Running. Press any key to stop the server.
pause >nul
taskkill /fi "WINDOWTITLE eq meridian-server*" /f >nul 2>&1
