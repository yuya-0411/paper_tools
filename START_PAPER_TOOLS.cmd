@echo off
setlocal
cd /d "%~dp0"
title paper_tools

if defined PAPER_TOOLS_PYTHON (
  if exist "%PAPER_TOOLS_PYTHON%" (
    "%PAPER_TOOLS_PYTHON%" -c "import sys; raise SystemExit(sys.version_info < (3, 11))" >nul 2>nul
    if not errorlevel 1 goto run_with_custom_python
  )
)

where py >nul 2>nul
if not errorlevel 1 (
  py -3 -c "import sys; raise SystemExit(sys.version_info < (3, 11))" >nul 2>nul
  if not errorlevel 1 goto run_with_py
)

where python >nul 2>nul
if not errorlevel 1 (
  python -c "import sys; raise SystemExit(sys.version_info < (3, 11))" >nul 2>nul
  if not errorlevel 1 goto run_with_python
)

where python3 >nul 2>nul
if not errorlevel 1 (
  python3 -c "import sys; raise SystemExit(sys.version_info < (3, 11))" >nul 2>nul
  if not errorlevel 1 goto run_with_python3
)

set "CODEX_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%CODEX_PYTHON%" (
  "%CODEX_PYTHON%" -c "import sys; raise SystemExit(sys.version_info < (3, 11))" >nul 2>nul
  if not errorlevel 1 goto run_with_codex_python
)

echo Python 3.11 or newer was not found.
echo Install Python, then double-click this file again.
pause
exit /b 1

:run_with_custom_python
"%PAPER_TOOLS_PYTHON%" "%~dp0scripts\bootstrap.py"
set "PAPER_TOOLS_EXIT=%ERRORLEVEL%"
goto finish

:run_with_py
py -3 "%~dp0scripts\bootstrap.py"
set "PAPER_TOOLS_EXIT=%ERRORLEVEL%"
goto finish

:run_with_python
python "%~dp0scripts\bootstrap.py"
set "PAPER_TOOLS_EXIT=%ERRORLEVEL%"
goto finish

:run_with_python3
python3 "%~dp0scripts\bootstrap.py"
set "PAPER_TOOLS_EXIT=%ERRORLEVEL%"
goto finish

:run_with_codex_python
"%CODEX_PYTHON%" "%~dp0scripts\bootstrap.py"
set "PAPER_TOOLS_EXIT=%ERRORLEVEL%"

:finish
if not "%PAPER_TOOLS_EXIT%"=="0" (
  echo.
  echo paper_tools could not start. Review the message above.
  pause
)
exit /b %PAPER_TOOLS_EXIT%
