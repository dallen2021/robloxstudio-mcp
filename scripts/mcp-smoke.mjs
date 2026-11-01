#!/usr/bin/env node
// dallen fork: offline MCP smoke test. Starts the built stdio server on a private
// port with a throwaway auth token and a required pin, so no Studio can attach
// and the shared bridge on 58741 is never touched. Sends initialize and
// tools/list, checks the fork's tools are present, then stops the server.
//   node scripts/mcp-smoke.mjs [--port 58995]
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portArg = process.argv.indexOf('--port');
const port = portArg > 0 ? process.argv[portArg + 1] : '58995';
const entry = path.join(root, 'packages/robloxstudio-mcp/dist/index.js');
const REQUIRED = ['pin_place', 'read_datastore', 'list_datastore_keys'];

const child = spawn(process.execPath, [entry], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    ROBLOX_STUDIO_PORT: port,
    ROBLOX_STUDIO_AUTH_TOKEN: randomBytes(24).toString('hex'),
    ROBLOX_STUDIO_REQUIRE_PIN: '1',
    ROBLOX_STUDIO_PLACE: '',
  },
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });

const pending = new Map();
let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`${method} timed out`)), 15000).unref();
  });
}

function finish(code, message) {
  console.log(message);
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 2000).unref();
  if (code !== 0 && stderr) console.error('--- server stderr ---\n' + stderr.slice(-2000));
  process.exitCode = code;
}

const killer = setTimeout(() => finish(1, 'FAIL: smoke test exceeded 30 s'), 30000);
try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dallen-fork-smoke', version: '1' },
  });
  if (init.error) throw new Error(`initialize: ${JSON.stringify(init.error)}`);
  const info = init.result.serverInfo;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await request('tools/list', {});
  if (list.error) throw new Error(`tools/list: ${JSON.stringify(list.error)}`);
  const names = list.result.tools.map((t) => t.name);
  const missing = REQUIRED.filter((n) => !names.includes(n));
  clearTimeout(killer);
  if (missing.length) finish(1, `FAIL: missing fork tools: ${missing.join(', ')}`);
  else finish(0, `OK: ${info.name} ${info.version}, protocol ${init.result.protocolVersion}, ${names.length} tools (fork tools present: ${REQUIRED.join(', ')})`);
} catch (err) {
  clearTimeout(killer);
  finish(1, `FAIL: ${err.message}`);
}
