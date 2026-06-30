// Standalone private metrics listener — a bare node:http server, NOT a
// second Fastify (we want zero middleware/auth surface and a tiny
// footprint). It binds a port that fly.toml does NOT declare in
// [http_service], so Fly's managed Prometheus scrapes it over the 6PN
// private network while it stays off the public internet.

import http from "node:http";
import { renderPrometheus, type MetricsSnapshot } from "./services/metrics.js";

export interface StartMetricsServerOpts {
  port: number;
  collect: () => Promise<MetricsSnapshot>;
  version: string;
}

export function startMetricsServer(opts: StartMetricsServerOpts): http.Server {
  const server = http.createServer((req, res) => {
    // Only GET /metrics is served; everything else is a 404 so the
    // surface is exactly one route.
    if (req.method !== "GET" || req.url !== "/metrics") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found\n");
      return;
    }
    void opts
      .collect()
      .then((snapshot) => {
        const body = renderPrometheus(snapshot, opts.version);
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        res.end(body);
      })
      .catch(() => {
        // Collection failed (e.g. DB unreachable beyond the probe) — 503
        // so the scrape records a gap rather than a misleading 200.
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("metrics collection failed\n");
      });
  });
  server.listen(opts.port, "0.0.0.0");
  return server;
}
