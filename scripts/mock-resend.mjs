#!/usr/bin/env node
// Mock Resend HTTP server for the live demo.
//
// Implements the endpoints the demo-manifest hits:
//   POST   /v1/accounts                       → { id }
//   POST   /v1/accounts/:id/confirm            → 200
//   POST   /v1/api-keys                        → { token }
//   DELETE /v1/accounts/:id                    → 204
//   POST   /v1/api-keys/rotate                 → { token }
//
// Responses are deterministic-ish (account/key ids embed a counter
// + the email alias) so demo logs stay readable across runs. No
// persistence — restart resets state, which is what a demo wants.

import http from "node:http";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.MOCK_RESEND_PORT ?? 4001);

let accountCounter = 0;
const accounts = new Map();

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body !== undefined ? JSON.stringify(body) : "");
}

function shortId() {
  return randomBytes(6).toString("hex");
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const method = req.method ?? "GET";
  const path = url.pathname;

  // Logs: terse but enough to follow a run by eye.
  const start = Date.now();
  res.on("finish", () => {
    process.stdout.write(`[mock-resend] ${method} ${path} -> ${res.statusCode} (${Date.now() - start}ms)\n`);
  });

  try {
    if (method === "GET" && path === "/health") {
      return send(res, 200, { ok: true, service: "mock-resend" });
    }

    if (method === "POST" && path === "/v1/accounts") {
      const body = await readJson(req);
      accountCounter += 1;
      const id = `acc_${accountCounter}_${shortId()}`;
      accounts.set(id, { email: body.email, display_name: body.display_name, confirmed: false });
      return send(res, 201, { id, email: body.email });
    }

    const confirmMatch = path.match(/^\/v1\/accounts\/([^/]+)\/confirm$/);
    if (method === "POST" && confirmMatch !== null) {
      const id = confirmMatch[1];
      const acc = accounts.get(id);
      if (acc === undefined) return send(res, 404, { error: "account_not_found" });
      acc.confirmed = true;
      return send(res, 200, { id, confirmed: true });
    }

    if (method === "POST" && path === "/v1/api-keys") {
      const token = `re_${shortId()}${shortId()}`;
      return send(res, 201, { token, id: shortId() });
    }

    if (method === "POST" && path === "/v1/api-keys/rotate") {
      const token = `re_${shortId()}${shortId()}`;
      return send(res, 200, { token });
    }

    const deleteAccMatch = path.match(/^\/v1\/accounts\/([^/]+)$/);
    if (method === "DELETE" && deleteAccMatch !== null) {
      const id = deleteAccMatch[1];
      accounts.delete(id);
      return send(res, 204);
    }

    send(res, 404, { error: "not_found", path });
  } catch (err) {
    send(res, 500, { error: "internal", message: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, () => {
  process.stdout.write(`[mock-resend] listening on http://localhost:${PORT}\n`);
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
