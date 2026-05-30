// Hardened server-side HTTP proxy for use_credential (multi-field).
//
// The agent describes an outbound call with ${SECRET} / ${SECRET.<field>}
// / ${SECRET_JSON[.field]} placeholders; the server injects the
// credential's decrypted fields and dispatches. The secret never crosses
// back to the agent, and never appears in any audit row or log line.
//
// ${SECRET}            → the field named "value", or the sole field
// ${SECRET.access_key} → that named field
// ${SECRET_JSON[.f]}   → JSON-escaped variant
//
// Guards (unchanged from the single-secret version, applied per field):
//   - placeholders rejected in url / method / header keys
//   - resolved values rejected if they contain CR/LF/NUL
//   - resulting header value capped at 8KB
//   - https-only, hostname resolved once + IP pinned (no rebinding),
//     post-resolution IP checked against private/link-local/CGNAT/NAT64
//   - response Content-Length cap (pre-read + mid-stream), MIME allowlist,
//     Set-Cookie stripped, per-account in-flight concurrency cap

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
  | "secret_field_missing"
  | "secret_ambiguous"
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

const TOKEN_SRC = "\\$\\{SECRET(_JSON)?(?:\\.([A-Za-z0-9_]+))?\\}";
const MAX_HEADER_VALUE_BYTES = 8 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024;

// ── Pure: secret substitution ──────────────────────────────────

export function jsonEscapeSecret(secret: string): string {
  const quoted = JSON.stringify(secret);
  return quoted.slice(1, -1);
}

function hasToken(s: string): boolean {
  return new RegExp(TOKEN_SRC).test(s);
}

// Resolve a single placeholder to its field value (throws on missing /
// ambiguous). `name` undefined → ${SECRET}: the "value" field, or the
// sole field if there's exactly one.
function resolveField(fields: Record<string, string>, name: string | undefined): string {
  if (name !== undefined) {
    const v = fields[name];
    if (v === undefined) {
      throw new ProxyError("secret_field_missing", `credential has no field '${name}'`);
    }
    return v;
  }
  if (fields.value !== undefined) return fields.value;
  const keys = Object.keys(fields);
  if (keys.length === 1) return fields[keys[0]!]!;
  throw new ProxyError(
    "secret_ambiguous",
    "credential has multiple fields — use ${SECRET.<field>}",
  );
}

function substituteAll(s: string, fields: Record<string, string>): string {
  return s.replace(new RegExp(TOKEN_SRC, "g"), (_m, json: string | undefined, name: string | undefined) => {
    const value = resolveField(fields, name);
    return json !== undefined ? jsonEscapeSecret(value) : value;
  });
}

export function substituteSecret(
  http: ProxyHttpRequest,
  fields: Record<string, string>,
): ProxyHttpRequest {
  for (const v of Object.values(fields)) {
    if (/[\r\n\0]/.test(v)) {
      throw new ProxyError("secret_unsafe_chars", "a credential field contains CR/LF/NUL");
    }
  }
  if (hasToken(http.url)) {
    throw new ProxyError("secret_in_url", "secret placeholder not allowed in url");
  }
  if (hasToken(http.method)) {
    throw new ProxyError("secret_in_method", "secret placeholder not allowed in method");
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(http.headers ?? {})) {
    if (hasToken(key)) {
      throw new ProxyError("secret_in_header_key", "secret placeholder not allowed in a header key");
    }
    const resolved = substituteAll(value, fields);
    if (Buffer.byteLength(resolved, "utf8") > MAX_HEADER_VALUE_BYTES) {
      throw new ProxyError("header_too_large", `header ${key} exceeds ${MAX_HEADER_VALUE_BYTES} bytes`);
    }
    headers[key] = resolved;
  }

  return {
    method: http.method,
    url: http.url,
    headers,
    ...(http.body !== undefined ? { body: substituteAll(http.body, fields) } : {}),
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
  if (p === null) return true;
  const [a, b] = p as [number, number, number, number];
  if (a === 0) return true;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function isBlockedAddress(addr: string): boolean {
  const kind = isIP(addr);
  if (kind === 4) return isBlockedIpv4(addr);
  if (kind !== 6) return true;
  const ip = addr.toLowerCase();
  if (ip === "::1" || ip === "::") return true;
  if (ip.startsWith("::ffff:")) {
    const tail = ip.slice("::ffff:".length);
    if (isIP(tail) === 4) return isBlockedIpv4(tail);
    return true;
  }
  if (ip.startsWith("64:ff9b:")) return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(ip)) return true;
  if (/^fe[89ab][0-9a-f]?:/.test(ip)) return true;
  return false;
}

// ── Executor ───────────────────────────────────────────────────

export interface DispatchInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
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
  lookup?: (hostname: string) => Promise<{ address: string; family: number }>;
  dispatch?: (input: DispatchInput) => Promise<DispatchResult>;
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
    fields: Record<string, string>;
  }): Promise<ProxyResult> {
    const resolved = substituteSecret(input.http, input.fields);

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
      throw new ProxyError("blocked_address", `${hostname} resolves to a blocked address`);
    }
    return resolved;
  }

  private sanitiseResponse(d: DispatchResult): ProxyResult {
    const headers: Record<string, string> = {};
    let contentType = "";
    for (const [k, v] of Object.entries(d.headers)) {
      const key = k.toLowerCase();
      if (key === "set-cookie") continue;
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
