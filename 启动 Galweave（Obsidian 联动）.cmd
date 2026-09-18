@echo off
if not exist "%~dp0src-tauri\target\release\galweave.exe" (
  echo Desktop build not found. Please build Galweave first.
  pause
  exit /b 1
)
start "" "%~dp0src-tauri\target\release\galweave.exe"
