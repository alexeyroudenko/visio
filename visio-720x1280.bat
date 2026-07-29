@echo off
setlocal
set "URL=https://visio.aa.arthew0.online/"
set "W=720"
set "H=1280"

rem Chromium --app = window without address bar / tabs / browser chrome.
rem Prefer Edge, then Chrome (typical install paths + PATH).

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if exist "%EDGE%" (
  start "" "%EDGE%" --app="%URL%" --window-size=%W%,%H% --window-position=40,40
  exit /b 0
)

if exist "%CHROME%" (
  start "" "%CHROME%" --app="%URL%" --window-size=%W%,%H% --window-position=40,40
  exit /b 0
)

where msedge >nul 2>&1 && (
  start "" msedge --app="%URL%" --window-size=%W%,%H% --window-position=40,40
  exit /b 0
)

where chrome >nul 2>&1 && (
  start "" chrome --app="%URL%" --window-size=%W%,%H% --window-position=40,40
  exit /b 0
)

echo Edge/Chrome not found. Install one of them, or edit this .bat with the browser path.
pause
exit /b 1
