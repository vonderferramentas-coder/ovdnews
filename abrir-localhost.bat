@echo off
setlocal
cd /d "%~dp0"
set "NODE_EXE=node"
if not exist "%NODE_EXE%" set "NODE_EXE=C:\Users\ovd12260\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
start "OVD News" /min "%NODE_EXE%" server.js
timeout /t 2 /nobreak >nul
start "" "http://localhost:4173"
endlocal