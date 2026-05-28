// ExtractFailureSnapshot — store interface + in-memory implementation.
//
// Persists DOM + screenshot blobs uploaded by the MCP when the
// universal bot's `extractCredentials()` returned null despite the
// LLM planner asserting a credential was visible. The data is ONLY
// used for human-driven UI-shape regression diagnosis; nothing else
// in the system reads from it.
//
// Retention: 7 days from upload. The store enforces expiry on read
// (lazy delete) AND a pruner method the server can call from a cron
// or on startup. Either path is safe — losing diagnostic data on a
// restart is acceptable.

import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

// 7 days. Chosen as the user-approved retention window for diagnostic
// data that may contain rendered PII (the bot's email alias, session
// cookies serialized into the HTML).
export const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// 5MB hard cap on uploaded HTML, 2MB on screenshot. Real signup
// modals are ~80-300KB HTML / ~200-400KB JPEG; these caps stop a
// pathological page (or an attacker) from filling the store.
export const MAX_HTML_BYTES = 5 * 1024 * 1024;
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

// Per-account upload rate limit: 500 snapshots/hour. A normal signup
// uploads ~20 per-round telemetry captures plus 0-1 extract-failures;
// 500/hr leaves room for ~20 back-to-back signups before throttling.
// Tight enough that a runaway bot can't fill storage. Was 50 before
// 0.6.14-rc.11 made per-round uploads default-on.
export const UPLOAD_RATE_LIMIT_PER_HOUR = 500;
export const UPLOAD_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export interface ExtractFailureUpload {
  service: string;
  mcp_version: string;
  url: string;
  title: string;
  step_label: string;
  extract_reason: string;
  // The bot's extractCredentialCandidates() output — list of strings
  // each pass returned. Useful for "why did Pass N not catch this?"
  candidates: ReadonlyArray<string>;
  // Raw HTML bytes. The store gzips before storing.
  html: string;
  // JPEG bytes base64-encoded — matches what the bot already produces.
  // Optional: a future feature-flag may suppress screenshot upload.
  screenshot_jpeg_base64?: string;
  // T45 — correlation id linking this snapshot to a ProvisionAttempt
  // from the same run. Optional for backwards-compat with older MCPs.
  provision_id?: string;
}

export interface ExtractFailureSummary {
  id: string;
  service: string;
  mcp_version: string;
  uploaded_at: Date;
  expires_at: Date;
  url: string;
  title: string;
  step_label: string;
  extract_reason: string;
  html_bytes: number;
  screenshot_bytes: number;
  provision_id: string | null;
}

export interface ExtractFailureDetail extends ExtractFailureSummary {
  // Decompressed HTML.
  html: string;
  // Raw JPEG bytes (NOT base64) — caller serializes as it sees fit.
  screenshot_jpeg: Buffer | null;
  candidates: ReadonlyArray<string>;
}

export class RateLimitedError extends Error {
  constructor(public readonly retry_after_seconds: number) {
    super(`upload rate limited, retry after ${retry_after_seconds}s`);
    this.name = "RateLimitedError";
  }
}

export class TooLargeError extends Error {
  constructor(public readonly field: "html" | "screenshot", public readonly bytes: number) {
    super(`${field} too large: ${bytes} bytes`);
    this.name = "TooLargeError";
  }
}

export interface ExtractFailureStore {
  upload(account_id: string, payload: ExtractFailureUpload): Promise<ExtractFailureSummary>;
  list(account_id: string, limit?: number): Promise<ExtractFailureSummary[]>;
  get(account_id: string, id: string): Promise<ExtractFailureDetail | null>;
  // T45 — admin-side view: all snapshots tagged with one provision_id
  // (i.e. one provision run), oldest-first. Used by the
  // /admin recent-failures gallery.
  listByProvisionId(provision_id: string): Promise<ExtractFailureSummary[]>;
  // Returns the number of rows pruned. Called by the server's cron or
  // ad-hoc; safe to call on every list() too (cheap when nothing is
  // expired).
  pruneExpired(now?: Date): Promise<number>;
}

interface InMemoryRow {
  id: string;
  account_id: string;
  service: string;
  mcp_version: string;
  uploaded_at: Date;
  expires_at: Date;
  url: string;
  title: string;
  step_label: string;
  extract_reason: string;
  candidates: ReadonlyArray<string>;
  html_gzip: Buffer;
  screenshot_jpeg: Buffer | null;
  html_bytes: number;
  screenshot_bytes: number;
  provision_id: string | null;
}

export interface ExtractFailureStoreListByProvisionId {
  /** T45 — fetch all snapshots tagged with the same provision_id (one
   *  run's per-round uploads), oldest-first. Used by the admin
   *  dashboard's "recent failed attempts" view. */
  listByProvisionId(provision_id: string): Promise<ExtractFailureSummary[]>;
}

export class InMemoryExtractFailureStore implements ExtractFailureStore {
  private rows = new Map<string, InMemoryRow>();
  // Per-account upload timestamps (ms epoch). Sliding window — drop
  // any older than UPLOAD_RATE_LIMIT_WINDOW_MS on each upload check.
  private uploadTimestamps = new Map<string, number[]>();

  // Override for tests. Default: real wall clock.
  private now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  async upload(account_id: string, payload: ExtractFailureUpload): Promise<ExtractFailureSummary> {
    const html_bytes = Buffer.byteLength(payload.html, "utf8");
    if (html_bytes > MAX_HTML_BYTES) throw new TooLargeError("html", html_bytes);

    let screenshot_jpeg: Buffer | null = null;
    let screenshot_bytes = 0;
    if (payload.screenshot_jpeg_base64 !== undefined && payload.screenshot_jpeg_base64.length > 0) {
      screenshot_jpeg = Buffer.from(payload.screenshot_jpeg_base64, "base64");
      screenshot_bytes = screenshot_jpeg.length;
      if (screenshot_bytes > MAX_SCREENSHOT_BYTES) {
        throw new TooLargeError("screenshot", screenshot_bytes);
      }
    }

    // Rate-limit check (sliding window).
    const nowMs = this.now().getTime();
    const cutoff = nowMs - UPLOAD_RATE_LIMIT_WINDOW_MS;
    const recent = (this.uploadTimestamps.get(account_id) ?? []).filter((t) => t > cutoff);
    if (recent.length >= UPLOAD_RATE_LIMIT_PER_HOUR) {
      const oldest = recent[0] ?? nowMs;
      const retry_after_seconds = Math.ceil((oldest + UPLOAD_RATE_LIMIT_WINDOW_MS - nowMs) / 1000);
      throw new RateLimitedError(Math.max(1, retry_after_seconds));
    }
    recent.push(nowMs);
    this.uploadTimestamps.set(account_id, recent);

    // Compress HTML for storage. gzipSync is fast on this scale
    // (~5-20ms for 300KB) and avoids the streams ceremony.
    const html_gzip = gzipSync(Buffer.from(payload.html, "utf8"));

    const id = randomUUID();
    const uploaded_at = this.now();
    const expires_at = new Date(uploaded_at.getTime() + SNAPSHOT_RETENTION_MS);

    const row: InMemoryRow = {
      id,
      account_id,
      service: payload.service,
      mcp_version: payload.mcp_version,
      uploaded_at,
      expires_at,
      url: payload.url,
      title: payload.title,
      step_label: payload.step_label,
      extract_reason: payload.extract_reason,
      candidates: payload.candidates,
      html_gzip,
      screenshot_jpeg,
      html_bytes,
      screenshot_bytes,
      provision_id: payload.provision_id ?? null,
    };
    this.rows.set(id, row);

    return this.toSummary(row);
  }

  async list(account_id: string, limit = 50): Promise<ExtractFailureSummary[]> {
    await this.pruneExpired();
    const results: ExtractFailureSummary[] = [];
    for (const row of this.rows.values()) {
      if (row.account_id !== account_id) continue;
      results.push(this.toSummary(row));
    }
    results.sort((a, b) => b.uploaded_at.getTime() - a.uploaded_at.getTime());
    return results.slice(0, Math.min(limit, 200));
  }

  async get(account_id: string, id: string): Promise<ExtractFailureDetail | null> {
    const row = this.rows.get(id);
    if (row === undefined) return null;
    // Belt + braces: never serve another account's snapshot.
    if (row.account_id !== account_id) return null;
    // Expired-but-not-pruned safety.
    if (row.expires_at.getTime() <= this.now().getTime()) {
      this.rows.delete(id);
      return null;
    }
    const html = gunzipSync(row.html_gzip).toString("utf8");
    return {
      ...this.toSummary(row),
      html,
      screenshot_jpeg: row.screenshot_jpeg,
      candidates: row.candidates,
    };
  }

  async pruneExpired(now?: Date): Promise<number> {
    const cutoff = (now ?? this.now()).getTime();
    let pruned = 0;
    for (const [id, row] of this.rows.entries()) {
      if (row.expires_at.getTime() <= cutoff) {
        this.rows.delete(id);
        pruned += 1;
      }
    }
    return pruned;
  }

  // T45 — admin dashboard view: all snapshots from a single
  // provision run, oldest-first (so the trail reads in
  // chronological order). Crosses account boundaries because admin
  // routes already gate by REGISTRY_ADMIN_BEARER; no per-account
  // filter here.
  async listByProvisionId(provision_id: string): Promise<ExtractFailureSummary[]> {
    const out: ExtractFailureSummary[] = [];
    for (const row of this.rows.values()) {
      if (row.provision_id !== provision_id) continue;
      out.push(this.toSummary(row));
    }
    out.sort((a, b) => a.uploaded_at.getTime() - b.uploaded_at.getTime());
    return out;
  }

  private toSummary(row: InMemoryRow): ExtractFailureSummary {
    return {
      id: row.id,
      service: row.service,
      mcp_version: row.mcp_version,
      uploaded_at: row.uploaded_at,
      expires_at: row.expires_at,
      url: row.url,
      title: row.title,
      step_label: row.step_label,
      extract_reason: row.extract_reason,
      html_bytes: row.html_bytes,
      screenshot_bytes: row.screenshot_bytes,
      provision_id: row.provision_id,
    };
  }
}
