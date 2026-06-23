@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
if exist "%SCRIPT_DIR%..\tsconfig.json" (
  rem Development mode
  set "TSCONFIG=%SCRIPT_DIR%..\tsconfig.json"
  set "SRC=%SCRIPT_DIR%..\src\index.ts"
  set "TSX=%SCRIPT_DIR%..\node_modules\tsx\dist\cli.mjs"
) else if exist "%SCRIPT_DIR%node_modules\spica-cli\tsconfig.json" (
  rem Global npm install/link mode
  set "TSCONFIG=%SCRIPT_DIR%node_modules\spica-cli\tsconfig.json"
  set "SRC=%SCRIPT_DIR%node_modules\spica-cli\src\index.ts"
  set "TSX=%SCRIPT_DIR%node_modules\spica-cli\node_modules\tsx\dist\cli.mjs"
)
if not defined TSX (
  echo Error: Could not locate spica-cli installation.
  exit /b 1
)
node "%TSX%" --tsconfig "%TSCONFIG%" "%SRC%" %*
