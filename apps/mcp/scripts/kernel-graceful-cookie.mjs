#!/usr/bin/env node
// Real Chrome regression: a normal broker/browser stop flushes a recent cookie.
// Run after `pnpm --filter @trusty-squire/mcp build`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BrokerClient } from '../dist/bot/broker/transport.js';
import { defaultBrokerSocket } from '../dist/bot/broker/discovery.js';
import { browserScopeIsEmpty } from '../dist/bot/browser-scope.js';

if (process.platform !== 'linux') throw new Error('Linux real-Chrome regression');
const root = await mkdtemp(join(process.cwd(), '.kernel-cookie-'));
const profile = join(root, 'profile');
let cookieSeen = false;
const server = createServer((req, res) => {
  if (req.url === '/set') res.setHeader('Set-Cookie', 'graceful=durable; Path=/; Max-Age=3600; SameSite=Lax');
  if (req.url === '/check') cookieSeen = req.headers.cookie?.includes('graceful=durable') ?? false;
  res.end('<html><body>cookie-ready</body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = route => `http://127.0.0.1:${server.address().port}${route}`;
const socket = defaultBrokerSocket(profile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let broker;
let client;
function launch() {
  broker = spawn(process.execPath, ['dist/bin.js', 'broker'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, TRUSTY_SQUIRE_PROFILE_DIR: profile },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  broker.stderr.on('data', chunk => process.stderr.write(String(chunk)));
}
async function attach() {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    try { return await BrokerClient.connect(socket); }
    catch { await sleep(50); }
  }
  throw new Error('broker did not attach');
}
try {
  launch();
  client = await attach();
  const first = await client.call('open', { serviceUrl: url('/set'), ceremony: true });
  await sleep(1300);
  assert((await client.call('close', { sessionId: first.sessionId,
    args: { session_id: first.sessionId } })).closed);
  await client.release();
  await sleep(100);
  broker.kill('SIGINT');
  const stopped = await Promise.race([
    new Promise(resolve => broker.once('exit', () => resolve(true))),
    sleep(10000).then(() => false),
  ]);
  assert(stopped, 'graceful broker shutdown timed out');
  assert(await browserScopeIsEmpty(profile), 'Chrome scope remained after graceful stop');
  launch();
  client = await attach();
  await client.call('open', { serviceUrl: url('/check'), ceremony: true });
  assert(cookieSeen, 'recent cookie was lost on normal whole-Chrome stop');
  console.log('recent cookie survived normal SIGINT browser stop and restart');
} finally {
  if (broker && broker.exitCode === null && broker.signalCode === null) {
    broker.kill('SIGKILL');
    await new Promise(resolve => broker.once('exit', resolve));
  }
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
