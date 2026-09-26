#!/usr/bin/env node
// Linux real-Chrome regression: a timed-out tab closes while its sibling stays
// usable, and the next session uses the same Chrome. Run after MCP build.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BrokerClient } from '../dist/bot/broker/transport.js';
import { defaultBrokerSocket } from '../dist/bot/broker/discovery.js';
import { browserScopeIsEmpty } from '../dist/bot/browser-scope.js';

if (process.platform !== 'linux') throw new Error('Linux real-Chrome regression');
const root = await mkdtemp(join(process.cwd(), '.kernel-timer-'));
const profile = join(root, 'profile');
const server = createServer((_req, res) => res.end('<html><body>session-ready</body></html>'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const broker = spawn(process.execPath, ['dist/bin.js', 'broker'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, TRUSTY_SQUIRE_PROFILE_DIR: profile,
    TRUSTY_SQUIRE_OPERATOR_BROWSER_MAX_LIFETIME_MS: '6000' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
broker.stderr.on('data', chunk => { stderr += String(chunk); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function chromePid() {
  const lines = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).split('\n');
  const rootLine = lines.find(line => line.includes(`--user-data-dir=${profile}`) &&
    line.includes('--remote-debugging-port=0') && !line.includes('--type='));
  assert(rootLine, 'shared Chrome root missing');
  return Number(rootLine.trim().split(/\s+/)[0]);
}
async function observe(client, sessionId) {
  return await client.call('command', { sessionId, name: 'operate_observe', args: { session_id: sessionId } });
}
let client;
try {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    try { client = await BrokerClient.connect(defaultBrokerSocket(profile)); break; }
    catch { await sleep(50); }
  }
  assert(client, `broker did not attach: ${stderr}`);
  const first = await client.call('open', { serviceUrl: url, ceremony: true });
  const originalPid = chromePid();
  await sleep(4200);
  const second = await client.call('open', { serviceUrl: url, ceremony: true });
  assert.equal(chromePid(), originalPid, 'sibling session launched another Chrome');
  await sleep(2300);
  await assert.rejects(observe(client, first.sessionId));
  assert(await observe(client, second.sessionId), 'sibling session stopped working');
  const third = await client.call('open', { serviceUrl: url, ceremony: true });
  assert(typeof third.sessionId === 'string');
  assert.equal(chromePid(), originalPid, 'timer restarted shared Chrome');
  console.log('timed-out tab closed; sibling and next session worked on the original Chrome');
} finally {
  broker.kill('SIGKILL');
  if (broker.exitCode === null && broker.signalCode === null)
    await new Promise(resolve => broker.once('exit', resolve));
  const until = Date.now() + 4500;
  while (!(await browserScopeIsEmpty(profile)) && Date.now() < until) await sleep(50);
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
