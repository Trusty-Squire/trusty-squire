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
//   - MIME allowlist, Set-Cookie stripped. execute() buffers for
//     use_credential and stays bounded by maxResponseBytes; executeStream()
//     forwards headers + body bytes as they arrive, unbounded — only the
//     DECOMPRESSED output of a compressed body keeps a ceiling there.

import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { PassThrough, Transform, pipeline } from "node:stream";
import type { Readable } from "node:stream";
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
} from "node:zlib";

// node:https/node:http send no User-Agent by default, and some providers
// (e.g. Zenodo) reject a header-less request with 403 as suspected scraping.
// Send a default UA on every proxied call; callers may still override it.
const DEFAULT_USER_AGENT = "trusty-squire/1.0 (+https://trustysquire.ai)";

export interface ProxyHttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  // Query params injected server-side AFTER the host allowlist check. This
  // is the sanctioned channel for APIs that authenticate via a query-string
  // key (FRED's `api_key`, some gov/weather APIs) — a `${SECRET}` is allowed
  // in a query VALUE here but still banned in `url` itself, so the secret
  // never appears in the agent-supplied URL that gets host-checked + audited.
  // Values are substituted + appended to the URL's searchParams at dispatch.
  query?: Record<string, string>;
}

export interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

// Headers are sanitised and ready to forward; `body` is the live upstream
// byte stream (already decompressed when we decoded).
export interface StreamedProxyResult {
  status: number;
  headers: Record<string, string>;
  body: Readable;
  truncated: boolean;
  // Settles with the number of body bytes that passed through, once the
  // pass-through ends or is torn down. Counted on the wire, never buffered —
  // it is what the audit row's response_size is amended to.
  bytesOut: Promise<number>;
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

// Field name is everything up to the closing brace, so credentials
// whose field labels contain spaces / hyphens / dots (the vault UI
// allows them, e.g. "Api key") can still be referenced as
// ${SECRET.Api key}. The `}` terminator bounds the match (it can't span
// a real brace), and the resolved VALUE is still CR/LF/NUL-checked, so
// widening the NAME class is safe. Previously [A-Za-z0-9_]+ silently
// failed to match such names → the literal placeholder shipped upstream.
const TOKEN_SRC = "\\$\\{SECRET(_JSON|_BASIC)?(?:\\.([^}]+))?\\}";
const MAX_HEADER_VALUE_BYTES = 8 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024;
// A compressed body can expand without bound, so the DECOMPRESSED output keeps
// a ceiling even on the streaming pass-through. This is process protection, not
// a gate on the caller — an uncompressed pass-through is forwarded unbounded.
const DEFAULT_MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
// Hop-by-hop headers plus content-length: a streamed reply is chunked, so a
// forwarded Content-Length would lie about (or race) the bytes we actually send.
const STREAM_RESPONSE_DROP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

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
  // Multiple fields, no "value": prefer the ONE whose name reads as the secret
  // (api_key/secret/token/key/password), excluding metadata (id/name/label). This
  // lets a bare ${SECRET} — e.g. an egress grant's `Bearer ${SECRET}` — resolve on
  // a multi-field credential (Deepgram id/name/secret) instead of erroring.
  const SECRETISH =
    /(?:secret|api[_-]?key|access[_-]?key|auth[_-]?token|\btoken\b|password|private[_-]?key|\bkey\b)/i;
  const NON_SECRET =
    /^(?:id|name|label|username|user|email|public[_-]?key|client[_-]?id|account[_-]?id)$/i;
  const secretish = keys.filter((k) => SECRETISH.test(k) && !NON_SECRET.test(k));
  if (secretish.length === 1) return fields[secretish[0]!]!;
  throw new ProxyError(
    "secret_ambiguous",
    "credential has multiple fields — use ${SECRET.<field>}",
  );
}

function substituteAll(s: string, fields: Record<string, string>): string {
  return s.replace(new RegExp(TOKEN_SRC, "g"), (_m, variant: string | undefined, name: string | undefined) => {
    if (variant === "_BASIC") {
      // Basic auth: base64("<username>:<secret>"), or base64("<secret>:") when
      // no username (key-as-username, blank-password). The username rides in the
      // `.` slot — ${SECRET_BASIC} vs ${SECRET_BASIC.<username>} — so the secret
      // itself is always the default field, never a named one.
      const secret = resolveField(fields, undefined);
      const userpass = name !== undefined ? `${name}:${secret}` : `${secret}:`;
      return Buffer.from(userpass, "utf8").toString("base64");
    }
    const value = resolveField(fields, name);
    return variant === "_JSON" ? jsonEscapeSecret(value) : value;
  });
}

export function substituteSecret(
  http: ProxyHttpRequest,
  fields: Record<string, string>,
  opts: { bodyVerbatim?: boolean } = {},
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

  let query: Record<string, string> | undefined;
  if (http.query !== undefined) {
    query = {};
    for (const [key, value] of Object.entries(http.query)) {
      // A secret in a query KEY makes no sense and would be a smuggling
      // vector — block it like header keys. Values may carry ${SECRET}.
      if (hasToken(key)) {
        throw new ProxyError("secret_in_header_key", "secret placeholder not allowed in a query-param key");
      }
      query[key] = substituteAll(value, fields);
    }
  }

  return {
    method: http.method,
    url: http.url,
    headers,
    ...(query !== undefined ? { query } : {}),
    ...(http.body !== undefined
      ? { body: opts.bodyVerbatim === true ? http.body : substituteAll(http.body, fields) }
      : {}),
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
  headersTimeoutMs: number;
  bodyTimeoutMs: number;
}

export interface DispatchResult {
  status: number;
  headers: Record<string, string | string[]>;
  truncated: boolean;
  // The live upstream body. A dispatcher resolves as soon as headers arrive,
  // so every response — buffered or streamed — is read from here.
  bodyStream: Readable;
}

export interface HttpProxyExecutorOptions {
  lookup?: (hostname: string) => Promise<{ address: string; family: number }>;
  dispatch?: (input: DispatchInput) => Promise<DispatchResult>;
  blockPrivate?: boolean;
  allowInsecureHttp?: boolean;
  maxResponseBytes?: number;
  maxDecompressedBytes?: number;
  headersTimeoutMs?: number;
  bodyTimeoutMs?: number;
}

export class HttpProxyExecutor {
  private readonly lookup: (hostname: string) => Promise<{ address: string; family: number }>;
  private readonly dispatch: (input: DispatchInput) => Promise<DispatchResult>;
  private readonly blockPrivate: boolean;
  private readonly allowInsecureHttp: boolean;
  private readonly maxResponseBytes: number;
  private readonly maxDecompressedBytes: number;
  private readonly headersTimeoutMs: number;
  private readonly bodyTimeoutMs: number;

  constructor(opts: HttpProxyExecutorOptions = {}) {
    this.lookup = opts.lookup ?? defaultLookup;
    this.dispatch = opts.dispatch ?? defaultDispatch;
    this.blockPrivate = opts.blockPrivate ?? true;
    this.allowInsecureHttp = opts.allowInsecureHttp ?? false;
    this.maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.maxDecompressedBytes = opts.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;
    this.headersTimeoutMs = opts.headersTimeoutMs ?? 5000;
    this.bodyTimeoutMs = opts.bodyTimeoutMs ?? 5000;
  }

  async execute(input: {
    accountId: string;
    http: ProxyHttpRequest;
    fields: Record<string, string>;
    // Egress-grant forwarding only: the body is the client workload's opaque
    // application payload (e.g. an LLM chat body), not an agent-authored
    // ${SECRET} template — it must reach upstream byte-for-byte, never
    // scanned or substituted. use_credential leaves this unset.
    bodyVerbatim?: boolean;
  }): Promise<ProxyResult> {
    const dispatchInput = await this.buildDispatchInput(input);
    const dispatched = await this.dispatch(dispatchInput);
    try {
      const headers = this.sanitiseHeaders(dispatched.headers);
      const piped = this.pipeBody(dispatched.bodyStream, headers, this.maxResponseBytes, {
        canHaveBody: responseCanHaveBody(dispatchInput.method, dispatched),
      });
      const body = await readBodyStream(piped.body);
      return { status: dispatched.status, headers, body, truncated: dispatched.truncated };
    } catch (err) {
      dispatched.bodyStream.destroy();
      throw err;
    }
  }

  // Resolves as soon as upstream headers arrive so a caller can start
  // forwarding bytes. use_credential keeps `execute` (buffered); egress
  // uses this so SSE / chat streams are not held until generation ends.
  // Nothing is buffered here, so no response-size gate applies — a long
  // generation must not be truncated mid-body by a cap that only ever
  // existed to bound memory.
  async executeStream(input: {
    accountId: string;
    http: ProxyHttpRequest;
    fields: Record<string, string>;
    bodyVerbatim?: boolean;
  }): Promise<StreamedProxyResult> {
    const dispatchInput = await this.buildDispatchInput(input);
    const dispatched = await this.dispatch(dispatchInput);
    try {
      const headers = this.headersForStream(dispatched.headers);
      const piped = this.pipeBody(dispatched.bodyStream, headers, Number.POSITIVE_INFINITY, {
        canHaveBody: responseCanHaveBody(dispatchInput.method, dispatched),
      });
      return {
        status: dispatched.status,
        headers,
        body: piped.body,
        truncated: dispatched.truncated,
        bytesOut: piped.bytesOut,
      };
    } catch (err) {
      dispatched.bodyStream.destroy();
      throw err;
    }
  }

  private async buildDispatchInput(input: {
    accountId: string;
    http: ProxyHttpRequest;
    fields: Record<string, string>;
    bodyVerbatim?: boolean;
  }): Promise<DispatchInput> {
    const resolved = substituteSecret(input.http, input.fields, {
      ...(input.bodyVerbatim !== undefined ? { bodyVerbatim: input.bodyVerbatim } : {}),
    });

    let url: URL;
    try {
      url = new URL(resolved.url);
    } catch {
      throw new ProxyError("invalid_url", "url is not parseable");
    }
    if (url.protocol !== "https:" && !(this.allowInsecureHttp && url.protocol === "http:")) {
      throw new ProxyError("not_https", "only https:// targets are permitted");
    }

    // Inject the substituted query params AFTER the URL is parsed (and after
    // the caller's host allowlist check, which ran on the secret-free url).
    // searchParams.set handles encoding; the secret lands only in the
    // dispatched URL, never the audited/logged one.
    if (resolved.query !== undefined) {
      for (const [key, value] of Object.entries(resolved.query)) {
        url.searchParams.set(key, value);
      }
    }

    const { address, family } = await this.resolveAndPin(url.hostname);

    const hasUserAgent = Object.keys(resolved.headers ?? {}).some(
      (k) => k.toLowerCase() === "user-agent",
    );
    return {
      method: resolved.method,
      url,
      headers: {
        ...(hasUserAgent ? {} : { "User-Agent": DEFAULT_USER_AGENT }),
        ...resolved.headers,
        host: url.host,
      },
      body: resolved.body,
      pinnedAddress: address,
      family,
      headersTimeoutMs: this.headersTimeoutMs,
      bodyTimeoutMs: this.bodyTimeoutMs,
    };
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

  private sanitiseHeaders(raw: Record<string, string | string[]>): Record<string, string> {
    const headers: Record<string, string> = {};
    let contentType = "";
    for (const [k, v] of Object.entries(raw)) {
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
    return headers;
  }

  private pipeBody(
    source: Readable,
    headers: Record<string, string>,
    maxBytes: number,
    opts: { canHaveBody: boolean },
  ): PipedResponseBody {
    return pipeResponseBody(source, headers, {
      maxBytes,
      maxDecompressedBytes: this.maxDecompressedBytes,
      canHaveBody: opts.canHaveBody,
    });
  }

  private headersForStream(raw: Record<string, string | string[]>): Record<string, string> {
    const headers = this.sanitiseHeaders(raw);
    for (const key of STREAM_RESPONSE_DROP_HEADERS) {
      delete headers[key];
    }
    return headers;
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
        // We resolve + SSRF-validate ONE address and pin it here. Happy
        // Eyeballs (autoSelectFamily, default true since Node 20) calls
        // a custom lookup with { all: true } and expects an ARRAY of
        // {address, family} back. The legacy single-address callback
        // form then trips ERR_INVALID_IP_ADDRESS ("Invalid IP address:
        // undefined"), which surfaced as upstream_error on EVERY proxied
        // call. Honor both callback contracts so it works regardless of
        // the autoSelectFamily default.
        lookup: (_h, opts, cb) => {
          if (opts.all === true) {
            cb(null, [{ address: input.pinnedAddress, family: input.family }]);
          } else {
            cb(null, input.pinnedAddress, input.family);
          }
        },
      },
      (res) => {
        // Resolve on headers so executeStream can start forwarding. IncomingMessage
        // stays paused until the consumer attaches; decode + metering happen there,
        // which is also where the buffered path's size bound lives — one owner.
        resolve({
          status: res.statusCode ?? 0,
          headers: { ...res.headers } as Record<string, string | string[]>,
          truncated: false,
          bodyStream: res,
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

function decoderForEncoding(enc: string): Transform | undefined {
  if (enc.includes("br")) return createBrotliDecompress();
  if (enc.includes("gzip") || enc.includes("x-gzip")) return createGunzip();
  if (enc.includes("deflate")) return createInflate();
  return undefined;
}

// 204/304, an informational status, and any response to HEAD carry no body by
// definition, and a declared zero length says the same. Handing an empty byte
// stream to a decompressor makes zlib fail with "unexpected end of file".
function responseCanHaveBody(
  method: string,
  dispatched: Pick<DispatchResult, "status" | "headers">,
): boolean {
  if (method.toUpperCase() === "HEAD") return false;
  const { status } = dispatched;
  if (status === 204 || status === 304 || (status >= 100 && status < 200)) return false;
  const declared = dispatched.headers["content-length"];
  return (Array.isArray(declared) ? declared[0] : declared) !== "0";
}

interface PipedResponseBody {
  body: Readable;
  bytesOut: Promise<number>;
}

// Decode (when we know the encoding), meter what leaves, and bound it. Mutates
// `headers` so they describe the bytes that leave this pipe. `maxBytes` is the
// caller's own memory bound (Infinity when it streams instead of buffering);
// `maxDecompressedBytes` is the bomb ceiling that applies whenever we inflate,
// because zlib's own maxOutputLength is inert for a streaming decompressor.
function pipeResponseBody(
  source: Readable,
  headers: Record<string, string>,
  limits: { maxBytes: number; maxDecompressedBytes: number; canHaveBody: boolean },
): PipedResponseBody {
  const enc = (headers["content-encoding"] ?? "").trim().toLowerCase();
  const decoder =
    limits.canHaveBody && enc !== "" && enc !== "identity"
      ? decoderForEncoding(enc)
      : undefined;
  if (decoder !== undefined) {
    // Body will be plaintext; these headers no longer describe it.
    delete headers["content-encoding"];
    delete headers["content-length"];
  }
  const limit =
    decoder !== undefined
      ? Math.min(limits.maxBytes, limits.maxDecompressedBytes)
      : limits.maxBytes;

  let total = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, cb) {
      total += chunk.length;
      if (total > limit) {
        source.destroy();
        cb(new ProxyError("response_too_large", "upstream body exceeded cap mid-stream"));
        return;
      }
      cb(null, chunk);
    },
  });

  const dest = new PassThrough();
  // A consumer (execute / Fastify) attaches its own error handler; this one
  // only prevents a late socket teardown after the body already ended from
  // becoming an unhandled exception.
  dest.on("error", () => undefined);
  let settleBytes: (bytes: number) => void = () => undefined;
  const bytesOut = new Promise<number>((resolve) => {
    settleBytes = resolve;
  });
  // Settles on success AND on teardown: a client that hangs up mid-stream still
  // gets its partial byte count into the audit row.
  const onDone = (): void => settleBytes(total);
  if (decoder !== undefined) {
    pipeline(source, decoder, meter, dest, onDone);
  } else {
    pipeline(source, meter, dest, onDone);
  }
  return { body: dest, bytesOut };
}

async function readBodyStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
  } catch (err) {
    throw err instanceof ProxyError
      ? err
      : new ProxyError("upstream_error", err instanceof Error ? err.message : String(err));
  }
  return Buffer.concat(chunks).toString("utf8");
}
