#!/usr/bin/env node
// Linux real-Chrome crash regression. Run after `pnpm --filter @trusty-squire/mcp build`:
//   node apps/mcp/scripts/kernel-broker-chaos.mjs [100]
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BrokerClient } from '../dist/bot/broker/transport.js';
import { defaultBrokerSocket } from '../dist/bot/broker/discovery.js';
import { browserScopeIsEmpty } from '../dist/bot/browser-scope.js';

if (process.platform !== 'linux') throw new Error('Linux real-Chrome regression');
const rounds = Number(process.argv[2] ?? 100);
assert(Number.isSafeInteger(rounds) && rounds > 0);
const root = await mkdtemp(join(process.cwd(), '.kernel-chaos-'));
const profile = join(root, 'profile');
const socket = defaultBrokerSocket(profile);
const env = {
  ...process.env,
  TRUSTY_SQUIRE_PROFILE_DIR: profile,
  BOT_START_TIMEOUT_MS: '30000',
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let signupSubmitResolve;
const server = createServer((req, res) => {
  if (req.url === '/signup') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<form action="/submit" method="post"><input name="email"><button>Sign up</button></form><script>document.querySelector("form").submit()</script>');
    return;
  }
  if (req.url === '/submit') {
    signupSubmitResolve?.();
    signupSubmitResolve = undefined;
    setTimeout(() => res.end('signed up'), 5000);
    return;
  }
  res.end('<html><body>browser-ready</body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = route => `http://127.0.0.1:${server.address().port}${route}`;
const launch = () => {
  const child = spawn(process.execPath, ['dist/bin.js', 'broker'], {
    cwd: new URL('..', import.meta.url).pathname,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.on('error', error => { stderr += String(error); });
  return { child, error: () => stderr };
};
async function attach(deadlineMs = 8000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try { return await BrokerClient.connect(socket, { handshakeTimeoutMs: 500 }); }
    catch { await sleep(50); }
  }
  throw new Error('broker attachment exceeded 8s');
}
async function open(client, route = '/') {
  return await client.call('open', { serviceUrl: url(route), ceremony: true });
}
async function assertGone(record) {
  const deadline = Date.now() + 4500;
  while (Date.now() < deadline) {
    const scopeEmpty = await browserScopeIsEmpty(profile);
    let processes = '';
    try { processes = execFileSync('pgrep', ['-af', `user-data-dir=${profile}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { /* no profile process */ }
    if (scopeEmpty && processes.trim() === '') return;
    await sleep(50);
  }
  throw new Error(`Chrome survived broker exit (scope or pgrep): ${record.error()}`);
}
async function kill(record) {
  if (record.child.exitCode === null && record.child.signalCode === null) {
    record.child.kill('SIGKILL');
    await new Promise(resolve => record.child.once('exit', resolve));
  }
  await assertGone(record);
}
let current;
let client;
try {
  current = launch();
  client = await attach();

  for (let index = 0; index < rounds; index++) {
    // Each round has one SIGKILL, immediately followed by a working session.
    const phases = ['launch', 'session', 'signup'];
    const phase = index < phases.length ? phases[index] : phases[Math.floor(Math.random() * phases.length)];
    let pending;
    if (phase === 'launch') {
      pending = open(client).catch(() => undefined);
      await sleep(20 + Math.floor(Math.random() * 200));
    } else if (phase === 'signup') {
      const submitted = new Promise(resolve => { signupSubmitResolve = resolve; });
      pending = open(client, '/signup').catch(() => undefined);
      await Promise.race([
        submitted,
        sleep(4000).then(() => { throw new Error('signup POST was not reached'); }),
      ]);
      await sleep(Math.floor(Math.random() * 300));
    } else {
      await sleep(50 + Math.floor(Math.random() * 300));
    }
    await kill(current);
    await pending;
    const started = Date.now();
    current = launch();
    client = await attach();
    const result = await open(client);
    assert(typeof result.sessionId === 'string', 'next session did not get a browser');
    assert(Date.now() - started < 9000, 'next session took over 9s');
    console.log(`${index + 1}/${rounds} ${phase}: next browser in ${Date.now() - started}ms; scope and pgrep empty after kill`);
  }
} finally {
  if (current) await kill(current).catch(error => console.error(error));
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
