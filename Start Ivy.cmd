@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title Ivy - Voice English Practice

if not exist node_modules (
  echo First run: installing dependencies, this takes a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo Something went wrong installing. Is Node.js installed? https://nodejs.org
    pause
    exit /b 1
  )
)

if not exist .env (
  echo.
  echo One-time setup: Ivy needs your Anthropic API key.
  echo It starts with sk-ant- ^(see HOW_TO_RUN.md, Part 1, if you don't have one^).
  echo.
  set /p IVY_KEY=Paste your key and press Enter:
  if "!IVY_KEY!"=="" (
    echo No key entered - closing.
    pause
    exit /b 1
  )
  >.env echo ANTHROPIC_API_KEY=!IVY_KEY!
  echo Saved to .env - you won't be asked again.
)

echo.
echo Starting Ivy... your browser will open in a moment.
echo Keep this window open while practicing. Close it to turn Ivy off.
echo.
start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:4780"
node server.js
pause
