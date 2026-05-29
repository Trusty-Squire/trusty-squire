// Hardened server-side HTTP proxy for use_credential.
//
// The agent describes an outbound call with ${SECRET} / ${SECRET_JSON}
// placeholders; the server injects the real secret and dispatches. The
// secret never crosses back to the agent, and never appears in any
// audit row or log line.
//
// Threat model (from the adversarial review — see plan §"use_credential
// proxy semantics — hardened"):
//   - Secret exfiltration via reflection → substitution is restricted to
//     header values + body; rejected in url/method/header-keys; CRLF/NUL
//     in the secret is rejected; resulting header values are size-capped.
//   - SSRF / metadata-endpoint access → https-only, hostname resolved
//     once and the IP pinned for the socket (no rebinding), post-
//     resolution IP checked against private/link-local/CGNAT/NAT64
//     ranges.
//   - Response-channel abuse → declared Content-Length > cap rejected
//     pre-read, stream aborted past the cap, response MIME restricted,
//     Set-Cookie stripped.
//   - Resource exhaustion → per-request timeouts + per-account in-flight
//     concurrency cap.
//
// Pure helpers (substituteSecret, isBlockedAddress) carry most of the
// security surface and are unit-tested in isolation; the network
// dispatch is injectable so route tests don't fight the SSRF guard.

import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";

export interface ProxyHttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

export type ProxyErrorCode =
  | "secret_in_url"
  | "secret_in_method"
  | "secret_in_header_key"
  | "secret_unsafe_chars"
  | "header_too_large"
  | "not_https"
  | "invalid_url"
  | "blocked_address"
  | "dns_failed"
  | "concurrency_limit"
  | "response_too_large"
  | "unsupported_response_type"
  | "upstream_error"
  | "timeout";

export class ProxyError extends Error {
  constructor(
    public readonly code: ProxyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProxyError";
  }
}

const SECRET_TOKEN = "${SECRET}";
const SECRET_JSON_TOKEN = "${SECRET_JSON}";
const MAX_HEADER_VALUE_BYTES = 8 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024;

// ── Pure: secret substitution ──────────────────────────────────

// JSON-escape a secret for embedding inside a JSON string the agent is
// building (e.g. body `{"key":"${SECRET_JSON}"}`). Returns the escaped
// inner WITHOUT the surrounding quotes — the agent supplies those.
export function jsonEscapeSecret(secret: string): string {
  const quoted = JSON.stringify(secret);
  return quoted.slice(1, -1);
}

// Resolve placeholders into the request. Throws ProxyError on any
// disallowed placement or unsafe secret. Single-pass: replacement text
// is never re-scanned for further tokens.
export function substituteSecret(
  http: ProxyHttpRequest,
  secret: string,
): ProxyHttpRequest {
  if (/[\r\n\0]/.test(secret)) {
    throw new ProxyError("secret_unsafe_chars", "secret contains CR/LF/NUL");
  }
  if (http.url.includes(SECRET_TOKEN) || http.url.includes(SECRET_JSON_TOKEN)) {
    throw new ProxyError("secret_in_url", "secret placeholder not allowed in url");
  }
  if (http.method.includes(SECRET_TOKEN) || http.method.includes(SECRET_JSON_TOKEN)) {
    throw new ProxyError("secret_in_method", "secret placeholder not allowed in method");
  }

  const jsonEscaped = jsonEscapeSecret(secret);
  const subst = (s: string): string =>
    s.split(SECRET_JSON_TOKEN).join(jsonEscaped).split(SECRET_TOKEN).join(secret);

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(http.headers ?? {})) {
    if (key.includes(SECRET_TOKEN) || key.includes(SECRET_JSON_TOKEN)) {
      throw new ProxyError("secret_in_header_key", "secret placeholder not allowed in a header key");
    }
    const resolved = subst(value);
    if (Buffer.byteLength(resolved, "utf8") > MAX_HEADER_VALUE_BYTES) {
      throw new ProxyError("header_too_large", `header ${key} exceeds ${MAX_HEADER_VALUE_BYTES} bytes`);
    }
    headers[key] = resolved;
  }

  return {
    method: http.method,
    url: http.url,
    headers,
    ...(http.body !== undefined ? { body: subst(http.body) } : {}),
  };
}

// ── Pure: SSRF address blocking ────────────────────────────────

function ipv4ToParts(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function isBlockedIpv4(ip: string): boolean {
  const p = ipv4ToParts(ip);
  if (p === null) return true; // unparseable → treat as blocked
  const [a, b] = p as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 169 && b === 254) return true; // link-local + metadata 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

// Reject loopback, private, link-local, CGNAT, and the IPv6 equivalents
// (incl. IPv4-mapped ::ffff: and NAT64 64:ff9b::). Unparseable → blocked.
export function isBlockedAddress(addr: string): boolean {
  const kind = isIP(addr);
  if (kind === 4) return isBlockedIpv4(addr);
  if (kind !== 6) return true; // not an IP literal → block

  const ip = addr.toLowerCase();
  if (ip === "::1" || ip === "::") return true; // loopback + unspecified
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:hhhh:hhhh) → apply v4 rules.
  if (ip.startsWith("::ffff:")) {
    const tail = ip.slice("::ffff:".length);
    if (isIP(tail) === 4) return isBlockedIpv4(tail);
    return true; // hex-form mapped — block conservatively
  }
  if (ip.startsWith("64:ff9b:")) return true; // NAT64
  // fc00::/7 (unique-local): first byte fc or fd.
  if (/^f[cd][0-9a-f]{0,2}:/.test(ip)) return true;
  // fe80::/10 (link-local): fe8x..febx.
  if (/^fe[89ab][0-9a-f]?:/.test(ip)) return true;
  return false;
}

// ── Executor ───────────────────────────────────────────────────

export interface DispatchInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
  // The resolved + validated IP to connect to (rebinding pin).
  pinnedAddress: string;
  family: number;
  maxResponseBytes: number;
  headersTimeoutMs: number;
  bodyTimeoutMs: number;
}

export interface DispatchResult {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
  truncated: boolean;
}

export interface HttpProxyExecutorOptions {
  // Injectable DNS — tests resolve a fake host to a known address.
  lookup?: (hostname: string) => Promise<{ address: string; family: number }>;
  // Injectable network dispatch — tests echo without real sockets.
  dispatch?: (input: DispatchInput) => Promise<DispatchResult>;
  // Test seams: allow loopback (default false) + http:// (default false).
  blockPrivate?: boolean;
  allowInsecureHttp?: boolean;
  maxResponseBytes?: number;
  headersTimeoutMs?: number;
  bodyTimeoutMs?: number;
  concurrencyPerAccount?: number;
}

export class HttpProxyExecutor {
  private readonly lookup: (hostname: string) => Promise<{ address: string; family: number }>;
  private readonly dispatch: (input: DispatchInput) => Promise<DispatchResult>;
  private readonly blockPrivate: boolean;
  private readonly allowInsecureHttp: boolean;
  private readonly maxResponseBytes: number;
  private readonly headersTimeoutMs: number;
  private readonly bodyTimeoutMs: number;
  private readonly concurrencyPerAccount: number;
  private readonly inFlight = new Map<string, number>();

  constructor(opts: HttpProxyExecutorOptions = {}) {
    this.lookup = opts.lookup ?? defaultLookup;
    this.dispatch = opts.dispatch ?? defaultDispatch;
    this.blockPrivate = opts.blockPrivate ?? true;
    this.allowInsecureHttp = opts.allowInsecureHttp ?? false;
    this.maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.headersTimeoutMs = opts.headersTimeoutMs ?? 5000;
    this.bodyTimeoutMs = opts.bodyTimeoutMs ?? 5000;
    this.concurrencyPerAccount = opts.concurrencyPerAccount ?? 4;
  }

  async execute(input: {
    accountId: string;
    http: ProxyHttpRequest;
    secret: string;
  }): Promise<ProxyResult> {
    const resolved = substituteSecret(input.http, input.secret);

    let url: URL;
    try {
      url = new URL(resolved.url);
    } catch {
      throw new ProxyError("invalid_url", "url is not parseable");
    }
    if (url.protocol !== "https:" && !(this.allowInsecureHttp && url.protocol === "http:")) {
      throw new ProxyError("not_https", "only https:// targets are permitted");
    }

    const { address, family } = await this.resolveAndPin(url.hostname);

    const slot = this.acquire(input.accountId);
    try {
      const dispatched = await this.dispatch({
        method: resolved.method,
        url,
        // Send the literal hostname as Host even though we connect to the
        // pinned IP — preserves vhost routing + TLS SNI.
        headers: { ...resolved.headers, host: url.host },
        body: resolved.body,
        pinnedAddress: address,
        family,
        maxResponseBytes: this.maxResponseBytes,
        headersTimeoutMs: this.headersTimeoutMs,
        bodyTimeoutMs: this.bodyTimeoutMs,
      });
      return this.sanitiseResponse(dispatched);
    } finally {
      slot();
    }
  }

  private async resolveAndPin(
    hostname: string,
  ): Promise<{ address: string; family: number }> {
    // A bare IP literal as hostname still gets range-checked.
    if (isIP(hostname) !== 0) {
      if (this.blockPrivate && isBlockedAddress(hostname)) {
        throw new ProxyError("blocked_address", `target ${hostname} is in a blocked range`);
      }
      return { address: hostname, family: isIP(hostname) };
    }
    let resolved: { address: string; family: number };
    try {
      resolved = await this.lookup(hostname);
    } catch {
      throw new ProxyError("dns_failed", `could not resolve ${hostname}`);
    }
    if (this.blockPrivate && isBlockedAddress(resolved.address)) {
      throw new ProxyError(
        "blocked_address",
        `${hostname} resolves to a blocked address`,
      );
    }
    return resolved;
  }

  private sanitiseResponse(d: DispatchResult): ProxyResult {
    const headers: Record<string, string> = {};
    let contentType = "";
    for (const [k, v] of Object.entries(d.headers)) {
      const key = k.toLowerCase();
      if (key === "set-cookie") continue; // never leak upstream cookies
      const value = Array.isArray(v) ? v.join(", ") : v;
      if (key === "content-type") contentType = value.toLowerCase();
      headers[key] = value;
    }
    const ok =
      contentType.startsWith("application/json") || contentType.startsWith("text/");
    if (!ok) {
      throw new ProxyError(
        "unsupported_response_type",
        `response content-type '${contentType}' not permitted`,
      );
    }
    return { status: d.status, headers, body: d.body, truncated: d.truncated };
  }

  private acquire(accountId: string): () => void {
    const current = this.inFlight.get(accountId) ?? 0;
    if (current >= this.concurrencyPerAccount) {
      throw new ProxyError(
        "concurrency_limit",
        `too many concurrent proxy calls for this account (max ${this.concurrencyPerAccount})`,
      );
    }
    this.inFlight.set(accountId, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.inFlight.get(accountId) ?? 1) - 1;
      if (n <= 0) this.inFlight.delete(accountId);
      else this.inFlight.set(accountId, n);
    };
  }
}

function defaultLookup(
  hostname: string,
): Promise<{ address: string; family: number }> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, (err, address, family) => {
      if (err !== null) reject(err);
      else resolve({ address, family });
    });
  });
}

// Real network path: connect to the pinned IP (lookup override defeats
// rebinding), keep the original Host header + TLS SNI, enforce the
// Content-Length precheck, byte cap, and timeouts.
function defaultDispatch(input: DispatchInput): Promise<DispatchResult> {
  const requestFn = input.url.protocol === "http:" ? httpRequest : httpsRequest;
  return new Promise<DispatchResult>((resolve, reject) => {
    const req = requestFn(
      {
        method: input.method,
        hostname: input.url.hostname,
        servername: input.url.hostname,
        port: input.url.port !== "" ? Number(input.url.port) : undefined,
        path: `${input.url.pathname}${input.url.search}`,
        headers: input.headers,
        // Pin the socket to the already-resolved + vetted address.
        lookup: (_h, _o, cb) => cb(null, input.pinnedAddress, input.family),
      },
      (res) => {
        const declared = Number(res.headers["content-length"] ?? "0");
        if (Number.isFinite(declared) && declared > input.maxResponseBytes) {
          res.destroy();
          reject(new ProxyError("response_too_large", "upstream Content-Length exceeds cap"));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > input.maxResponseBytes) {
            res.destroy();
            reject(new ProxyError("response_too_large", "upstream body exceeded cap mid-stream"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[]>,
            body: Buffer.concat(chunks).toString("utf8"),
            truncated: false,
          });
        });
      },
    );
    req.setTimeout(input.headersTimeoutMs + input.bodyTimeoutMs, () => {
      req.destroy(new ProxyError("timeout", "upstream timed out"));
    });
    req.on("error", (err) => {
      reject(err instanceof ProxyError ? err : new ProxyError("upstream_error", err.message));
    });
    if (input.body !== undefined) req.write(input.body);
    req.end();
  });
}
