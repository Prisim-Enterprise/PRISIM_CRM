// Sets up and runs the FastAPI auth service (apps/auth) on Windows, macOS and Linux.
//   node scripts/auth.mjs setup   → create .venv and install requirements
//   node scripts/auth.mjs dev     → run with auto-reload on port 4100
//   node scripts/auth.mjs test    → run pytest
import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'auth');
const win = process.platform === 'win32';
const venvPy = join(dir, '.venv', win ? 'Scripts/python.exe' : 'bin/python');
const cmd = process.argv[2] ?? 'dev';

if (cmd === 'setup' || !existsSync(venvPy)) {
  const sysPy = win ? 'python' : 'python3';
  if (!existsSync(venvPy)) spawnSync(sysPy, ['-m', 'venv', '.venv'], { cwd: dir, stdio: 'inherit' });
  const r = spawnSync(venvPy, ['-m', 'pip', 'install', '-r', 'requirements-dev.txt'], { cwd: dir, stdio: 'inherit' });
  if (r.status) process.exit(r.status);
  if (cmd === 'setup') process.exit(0);
}

const args = cmd === 'test'
  ? ['-m', 'pytest', '-q']
  : ['-m', 'uvicorn', 'app.main:app', '--port', process.env.AUTH_PORT || '4100', '--reload'];
const child = spawn(venvPy, args, { cwd: dir, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
