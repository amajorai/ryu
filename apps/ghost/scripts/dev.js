// Ghost dev script: Ghost is a stdio MCP server (`ghost mcp`), not a long-running
// HTTP service. Core spawns it on demand via its MCP registry, so there is nothing
// useful to keep "running" in dev. What dev needs is the binary compiled and ready,
// so this builds it (debug) and exits. Run `cargo run -- mcp` manually to drive the
// MCP server over stdio with a client.
const { spawn } = require('child_process');

console.log('[ghost] building debug binary (spawned on demand by Core via MCP)...');

const child = spawn('cargo', ['build'], {
  stdio: 'inherit',
  env: process.env,
  shell: false,
});
child.on('exit', (code) => {
  if (code === 0 || code === null) {
    console.log('[ghost] ready — Core will spawn `ghost mcp` on demand.');
  }
  process.exit(code ?? 0);
});
