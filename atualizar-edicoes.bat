@echo off
setlocal
cd /d "%~dp0"
set "PYTHON_EXE=C:\Users\ovd12260\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%PYTHON_EXE%" goto executar

where py >nul 2>nul
if not errorlevel 1 (
  set "PYTHON_EXE=py -3"
  goto executar
)

where python >nul 2>nul
if not errorlevel 1 (
  set "PYTHON_EXE=python"
  goto executar
)

echo Python nao foi encontrado neste computador.
goto fim

:executar
%PYTHON_EXE% gerar-edicoes.py

:fim
pause
endlocal
