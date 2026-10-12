@echo off
setlocal
cd /d "%~dp0"

rem ============================================================
rem  feiyu-memory -- one-click self check (double-click to run)
rem
rem  Why this exists: node is not on PATH on a typical machine,
rem  so `node --test` just fails. This finds the copy of node
rem  that DeepSeek Harness ships with.
rem
rem  NOTE: keep this file ASCII-only. cmd.exe reads .cmd files
rem  using the OEM code page (936 on Chinese Windows), so UTF-8
rem  text here would corrupt the parser.
rem ============================================================

set "NODE="

rem 1) Prefer the node bundled with DeepSeek Harness: known version,
rem    so test behaviour matches what CI and the author see.
for /d %%D in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
  if not defined NODE if exist "%%~fD\dependencies\node\bin\node.exe" set "NODE=%%~fD\dependencies\node\bin\node.exe"
)

rem 2) Fall back to node on PATH.
if not defined NODE for %%I in (node.exe) do if not defined NODE set "NODE=%%~$PATH:I"

if not defined NODE (
  echo.
  echo   [x] node not found.
  echo.
  echo   If DeepSeek Harness is installed it ships one at:
  echo     %%USERPROFILE%%\.dsh\dsh-runtimes\*\dependencies\node\bin\node.exe
  echo.
  echo   Otherwise install an LTS build from https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo   using node: %NODE%
echo.

echo ============================================================
echo   1/2  running tests
echo ============================================================
"%NODE%" --test
set "RC=%ERRORLEVEL%"

echo.
echo ============================================================
echo   2/2  checking cordis.patch.yml
echo ============================================================
"%NODE%" tools\check-patch-yaml.mjs
if errorlevel 2 echo   (js-yaml not found, skipping. This check only; the plugin is unaffected.)

echo.
if "%RC%"=="0" (
  echo   [OK] all tests passed.
) else (
  echo   [x] some tests failed. Scroll up for the lines marked with x.
)
echo.
pause
