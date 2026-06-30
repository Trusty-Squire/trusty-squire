#!/usr/bin/env node
// Crude load test (checklist #12) — find the API's breaking point before HN does.
//
// Hand-rolled (no deps) with a per-level socket pool sized to the concurrency,
// so the client never queues requests internally and the measured latency is
// the SERVER's, not our own backpressure. Ramps through concurrency levels and
// prints p50/p95/p99 + error rate + throughput per level.
//
// Usage:
//   node tools/loadtest.mjs <url> [levels=25,50,100,200] [secondsPerLevel=6]
//   node tools/loadtest.mjs https://trusty-squire-api.fly.dev/readyz
//
// Use READ-ONLY endpoints (/health, /readyz, /v1/status) against prod — they
// create no data and aren't rate-limited. /readyz exercises the DB pool (the
// likely bottleneck); /health is shallow (pure HTTP/edge capacity).
import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";

const url = process.argv[2];
if (!url) {
  console.error("usage: node tools/loadtest.mjs <url> [levels] [secondsPerLevel]");
  process.exit(1);
}
const levels = (process.argv[3] ?? "25,50,100,200").split(",").map(Number);
const durMs = Number(process.argv[4] ?? 6) * 1000;
const lib = url.startsWith("https:") ? https : http;

function once(agent) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const req = lib.get(url, { agent }, (res) => {
      res.on("data", () => {});
      res.on("end", () =>
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, code: res.statusCode, ms: performance.now() - t0 }),
      );
    });
    req.on("error", () => resolve({ ok: false, code: 0, ms: performance.now() - t0 }));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ ok: false, code: -1, ms: performance.now() - t0 });
    });
  });
}

async function level(concurrency) {
  const agent = new lib.Agent({ maxSockets: concurrency, keepAlive: true });
  const results = [];
  const deadline = performance.now() + durMs;
  const worker = async () => {
    while (performance.now() < deadline) results.push(await once(agent));
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  agent.destroy();
  return results;
}

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};
const pad = (v, n) => String(v).padEnd(n);

console.log(`\nload test → ${url}   (${durMs / 1000}s per level)\n`);
console.log("conc   reqs    errs   rps     p50     p95     p99     max   codes");
for (const c of levels) {
  const r = await level(c);
  const lat = r.map((x) => x.ms);
  const errs = r.filter((x) => !x.ok).length;
  const rps = (r.length / (durMs / 1000)).toFixed(0);
  const codes = [...new Set(r.map((x) => x.code))].sort((a, b) => a - b).join("/");
  console.log(
    `${pad(c, 6)} ${pad(r.length, 7)} ${pad(errs, 6)} ${pad(rps, 7)} ` +
      `${pad(pct(lat, 50).toFixed(0), 7)} ${pad(pct(lat, 95).toFixed(0), 7)} ${pad(pct(lat, 99).toFixed(0), 7)} ` +
      `${pad(Math.max(...lat).toFixed(0), 5)} ${codes}`,
  );
}
console.log("");
