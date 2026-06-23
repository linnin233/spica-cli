#!/usr/bin/env node
import { writeFileSync, chmodSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binDir = join(__dirname, '..', 'bin');
const binPath = join(binDir, 'spica');
const cmdPath = join(binDir, 'spica.cmd');

mkdirSync(binDir, { recursive: true });

// Cross-platform Node.js script (replaces bash - works on Windows, macOS, Linux)
const nodeContent = `#!/usr/bin/env node
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(__dirname, '..');

let tsconfig = resolve(projectDir, 'tsconfig.json');
let src = resolve(projectDir, 'src', 'index.ts');

// Check if running from global npm install/link
const globalPath = resolve(projectDir, 'node_modules', 'spica-cli', 'tsconfig.json');
if (existsSync(globalPath)) {
  tsconfig = globalPath;
  src = resolve(projectDir, 'node_modules', 'spica-cli', 'src', 'index.ts');
}

const tsxPath = resolve(projectDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const { spawn } = await import('child_process');
const proc = spawn(process.execPath, [tsxPath, '--tsconfig', tsconfig, src, ...process.argv.slice(2)], { stdio: 'inherit' });
proc.on('exit', (code) => process.exit(code ?? 1));
`;

writeFileSync(binPath, nodeContent, 'utf-8');

// Windows .cmd wrapper for direct invocation
const winContent = `@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
if exist "%SCRIPT_DIR%..\\tsconfig.json" (
  rem Development mode
  set "TSCONFIG=%SCRIPT_DIR%..\\tsconfig.json"
  set "SRC=%SCRIPT_DIR%..\\src\\index.ts"
  set "TSX=%SCRIPT_DIR%..\\node_modules\\tsx\\dist\\cli.mjs"
) else if exist "%SCRIPT_DIR%node_modules\\spica-cli\\tsconfig.json" (
  rem Global npm install/link mode
  set "TSCONFIG=%SCRIPT_DIR%node_modules\\spica-cli\\tsconfig.json"
  set "SRC=%SCRIPT_DIR%node_modules\\spica-cli\\src\\index.ts"
  set "TSX=%SCRIPT_DIR%node_modules\\spica-cli\\node_modules\\tsx\\dist\\cli.mjs"
)
if not defined TSX (
  echo Error: Could not locate spica-cli installation.
  exit /b 1
)
node "%TSX%" --tsconfig "%TSCONFIG%" "%SRC%" %*
`;

writeFileSync(cmdPath, winContent, 'utf-8');

try {
  chmodSync(binPath, 0o755);
} catch {
  // chmod not supported on Windows, skip silently
}
