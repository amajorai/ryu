// Shadow dev script: kills a stale shadow process (frees :3030), then spawns the
// HTTP server via `cargo run -- start`. Shadow is the context engine the island
// (apps/island) polls at :3030 for screen context + proactive suggestions, so it
// must be running for the companion's context features to work in dev.
const { execSync, spawn } = require('child_process');
const { existsSync, openSync, closeSync } = require('fs');
const path = require('path');

const exePath = path.resolve(
  __dirname,
  '..',
  'target',
  'debug',
  process.platform === 'win32' ? 'shadow.exe' : 'shadow'
);

if (process.platform === 'win32') {
  try { execSync('taskkill /F /IM shadow.exe', { stdio: 'ignore' }); } catch {}
  // Poll up to 15s until the compiled exe is no longer locked by the old process.
  for (let i = 0; i < 15; i++) {
    try { execSync('cmd /c timeout /t 1 /nobreak', { stdio: 'ignore' }); } catch {}
    if (!existsSync(exePath)) break;
    try { closeSync(openSync(exePath, 'r+')); break; } catch {}
  }
} else {
  try { execSync("pkill -f 'shadow start'", { stdio: 'ignore' }); } catch {}
}

const child = spawn('cargo', ['run', '--', 'start'], {
  stdio: 'inherit',
  env: process.env,
  shell: false,
});
child.on('exit', (code) => process.exit(code ?? 0));
