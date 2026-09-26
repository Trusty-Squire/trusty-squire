#!/usr/bin/env node
// Real Chrome regression: no systemd user bus still opens a working browser.
// Run after `pnpm --filter @trusty-squire/mcp build`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') throw new Error('Linux real-Chrome regression');
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('./kernel-graceful-cookie.mjs', import.meta.url)),
], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: {
    ...process.env,
    XDG_RUNTIME_DIR: '/nonexistent',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent',
  },
  encoding: 'utf8',
  timeout: 45_000,
});
assert.equal(result.status, 0, result.stderr || String(result.error));
assert.match(result.stderr, /Chrome containment=process-group/);
assert.match(result.stdout, /recent cookie survived normal SIGINT browser stop and restart/);
console.log('no-systemd broker opened Chrome, kept a recent cookie, and stopped normally');
