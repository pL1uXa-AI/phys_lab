@echo off
title Phys Lab
cd /d "%~dp0"

echo ============================================================
echo   Phys Lab - sandbox of molecular dynamics
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH.
  echo Install Node.js 18 or newer: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set NODEVER=%%v
echo Node.js: %NODEVER%

if not exist "package.json" (
  echo [ERROR] package.json not found.
  echo Run this file from the phys-lab project folder.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\vite" (
  echo.
  echo Dependencies are not installed. Running npm install...
  echo This takes a minute or two on the first run.
  echo.
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo [ERROR] Failed to install dependencies.
    echo Check your internet connection and try again.
    echo.
    pause
    exit /b 1
  )
)

if "%PORT%"=="" set PORT=4174

set NEED_BUILD=0
if not exist "dist\index.html" set NEED_BUILD=1
if "%ALWAYS_BUILD%"=="1" set NEED_BUILD=1

if "%NEED_BUILD%"=="1" (
  echo.
  echo Building the application...
  call npm.cmd run build
  if errorlevel 1 (
    echo.
    echo [ERROR] Build failed. See details above.
    echo.
    pause
    exit /b 1
  )
)

echo.
echo URL:   http://localhost:%PORT%
echo Stop:  Ctrl+C in this window, or just close it.
echo ============================================================
echo.

if not "%NO_BROWSER%"=="1" (
  start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%/"
)

call npx.cmd vite preview --port %PORT% --strictPort

echo.
echo Server stopped.
pause
