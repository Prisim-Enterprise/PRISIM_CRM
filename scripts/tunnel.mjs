// Starts the ngrok tunnel to the local API on the fixed domain set in .env (NGROK_DOMAIN).
// One-time setup: create a free ngrok account, then run `ngrok config add-authtoken <token>`.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envFile = resolve(import.meta.dirname, '..', '.env');
const env = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
const domain = process.env.NGROK_DOMAIN || /^NGROK_DOMAIN="?([^"\r\n]+)"?/m.exec(env)?.[1];
if (!domain) {
  console.error('[tunnel] Set NGROK_DOMAIN in .env (your free static domain, e.g. prisim-crm.ngrok-free.app)');
  process.exit(1);
}
const port = process.env.PORT || '4000';
console.log(`[tunnel] https://${domain} → http://127.0.0.1:${port}`);
const child = spawn('ngrok', ['http', `--url=${domain}`, port, '--log=stdout', '--log-level=warn'], { stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
