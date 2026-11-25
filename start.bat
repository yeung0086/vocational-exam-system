@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 22+ was not found.
  echo Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

netstat -ano | findstr ":3000" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo [INFO] Port 3000 is already listening.
  echo [INFO] Opening http://localhost:3000/
  start "" "http://localhost:3000/"
  exit /b 0
)

echo [INFO] Starting the exam system on http://localhost:3000/
start "Exam Server" cmd /k node server.js
timeout /t 2 /nobreak >nul
start "" "http://localhost:3000/"
exit /b 0
