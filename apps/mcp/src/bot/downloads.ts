import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Download, Page, Response } from "playwright";

// Browser downloads a session's pages start. Playwright already accepts
// downloads into its own artifacts directory and emits `download` on the page
// that started one; this module records them per session, moves each finished
// file into a private per-session folder, and hashes it off the event loop.

export type DownloadState = "in_progress" | "complete" | "failed";

export interface DownloadRecord {
  download_id: string;
  state: DownloadState;
  filename: string;
  mime_type: string;
  /** Absolute path on the broker host. Set once the file is in the session folder. */
  path: string | null;
  size_bytes: number | null;
  sha256: string | null;
  error?: string;
}

interface Entry {
  record: DownloadRecord;
  version: number;
  reported: number;
  settled: Promise<void>;
  download: Download | null;
}

const DEFAULT_SESSION_CAP_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_HANDLE_TTL_MS = 5 * 60_000;
const RECENT_RESPONSE_LIMIT = 64;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".bin": "application/octet-stream",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".gz": "application/gzip",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".zip": "application/zip",
};

export function downloadsRoot(): string {
  const configured = process.env.TRUSTY_SQUIRE_DOWNLOADS_DIR?.trim();
  return configured ? configured : join(homedir(), ".trusty-squire", "downloads");
}

function sessionCapBytes(): number {
  const parsed = Number(process.env.TRUSTY_SQUIRE_DOWNLOAD_SESSION_CAP_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_CAP_BYTES;
}

function handleTtlMs(): number {
  const parsed = Number(process.env.TRUSTY_SQUIRE_DOWNLOAD_HANDLE_TTL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HANDLE_TTL_MS;
}

/** A single path segment: no separators, control characters, or dot names. */
export function safeDownloadFilename(suggested: string): string {
  const cleaned = basename(suggested.replace(/[\\/]/g, "_"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "download" : cleaned;
}

function mimeFor(filename: string, contentType: string | undefined): string {
  const declared = contentType?.split(";")[0]?.trim().toLowerCase();
  if (declared) return declared;
  return MIME_BY_EXTENSION[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One session's downloads. Records never cross to another tracker. */
export class SessionDownloads {
  private readonly entries = new Map<string, Entry>();
  private readonly watched = new WeakSet<Page>();
  private readonly contentTypes = new Map<string, string>();
  private folder: Promise<string> | null = null;
  private committedBytes = 0;
  private sequence = 0;

  /** Record every download this page starts. Idempotent per page. */
  watch(page: Page): void {
    if (this.watched.has(page)) return;
    this.watched.add(page);
    const onResponse = (response: Response): void => {
      const contentType = response.headers()["content-type"];
      if (contentType === undefined) return;
      this.contentTypes.delete(response.url());
      this.contentTypes.set(response.url(), contentType);
      if (this.contentTypes.size > RECENT_RESPONSE_LIMIT) {
        const oldest = this.contentTypes.keys().next().value;
        if (oldest !== undefined) this.contentTypes.delete(oldest);
      }
    };
    const onDownload = (download: Download): void => this.begin(download);
    page.on("response", onResponse);
    page.on("download", onDownload);
    page.once("close", () => {
      page.off("response", onResponse);
      page.off("download", onDownload);
    });
  }

  /** Records whose state changed since the last report, oldest first. */
  takeReport(): DownloadRecord[] {
    const changed: DownloadRecord[] = [];
    for (const entry of this.entries.values()) {
      if (entry.reported === entry.version) continue;
      entry.reported = entry.version;
      changed.push({ ...entry.record });
    }
    return changed;
  }

  get(downloadId: string): DownloadRecord | undefined {
    const entry = this.entries.get(downloadId);
    return entry === undefined ? undefined : { ...entry.record };
  }

  list(): DownloadRecord[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.record }));
  }

  /** Sequence marker; `since(marker)` returns downloads started after it. */
  marker(): number {
    return this.sequence;
  }

  since(marker: number): DownloadRecord[] {
    return [...this.entries.values()].slice(marker).map((entry) => ({ ...entry.record }));
  }

  hasInProgress(): boolean {
    return [...this.entries.values()].some((entry) => entry.record.state === "in_progress");
  }

  /** Wait until no download started after `marker` is in progress, or until `timeoutMs` passes. */
  async settle(timeoutMs: number, signal?: AbortSignal, marker = 0): Promise<void> {
    const pending = [...this.entries.values()]
      .slice(marker)
      .filter((entry) => entry.record.state === "in_progress")
      .map((entry) => entry.settled);
    if (pending.length === 0) return;
    await waitBounded(Promise.all(pending), timeoutMs, signal);
  }

  /** Wait for one download to finish. Returns the record in its latest state. */
  async wait(
    downloadId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DownloadRecord | undefined> {
    const entry = this.entries.get(downloadId);
    if (entry === undefined) return undefined;
    if (entry.record.state === "in_progress") await waitBounded(entry.settled, timeoutMs, signal);
    return { ...entry.record };
  }

  /** Cancel running downloads, revoke handles, and delete the session folder. */
  async dispose(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.sequence = 0;
    this.committedBytes = 0;
    revokeHandlesFor(this);
    await Promise.all(
      entries.map(async (entry) => {
        await entry.download?.cancel().catch(() => undefined);
        await entry.download?.delete().catch(() => undefined);
      }),
    );
    const folder = this.folder;
    this.folder = null;
    if (folder !== null) {
      const path = await folder.catch(() => null);
      if (path !== null) await rm(path, { recursive: true, force: true });
    }
  }

  private sessionFolder(): Promise<string> {
    if (this.folder === null) {
      const root = downloadsRoot();
      this.folder = mkdir(root, { recursive: true, mode: 0o700 }).then(
        async () => await mkdtemp(join(root, "session-")),
      );
    }
    return this.folder;
  }

  private begin(download: Download): void {
    const downloadId = `dl-${randomBytes(6).toString("hex")}`;
    const filename = safeDownloadFilename(download.suggestedFilename());
    const entry: Entry = {
      record: {
        download_id: downloadId,
        state: "in_progress",
        filename,
        mime_type: mimeFor(filename, this.contentTypes.get(download.url())),
        path: null,
        size_bytes: null,
        sha256: null,
      },
      version: 1,
      reported: 0,
      settled: Promise.resolve(),
      download,
    };
    this.entries.set(downloadId, entry);
    this.sequence += 1;
    entry.settled = this.finish(entry, download);
  }

  private async finish(entry: Entry, download: Download): Promise<void> {
    const update = (patch: Partial<DownloadRecord>): void => {
      if (this.entries.get(entry.record.download_id) !== entry) return;
      entry.record = { ...entry.record, ...patch };
      entry.version += 1;
    };
    let counted = 0;
    try {
      const staged = await download.path();
      const failure = await download.failure();
      if (failure !== null) throw new Error(failure);
      const size = (await stat(staged)).size;
      if (this.committedBytes + size > sessionCapBytes())
        throw new Error("session_download_cap_exceeded");
      this.committedBytes += size;
      counted = size;
      const folder = join(await this.sessionFolder(), entry.record.download_id);
      await mkdir(folder, { mode: 0o700 });
      const path = join(folder, entry.record.filename);
      await download.saveAs(path);
      await download.delete().catch(() => undefined);
      const sha256 = await sha256File(path);
      if (this.entries.get(entry.record.download_id) !== entry) {
        await rm(folder, { recursive: true, force: true });
        return;
      }
      update({ state: "complete", path, size_bytes: size, sha256 });
    } catch (error) {
      if (this.entries.get(entry.record.download_id) === entry) this.committedBytes -= counted;
      await download.delete().catch(() => undefined);
      update({ state: "failed", error: errorText(error) });
    } finally {
      entry.download = null;
    }
  }
}

async function waitBounded(
  work: Promise<unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
      new Promise<void>((_, reject) => {
        if (signal === undefined) return;
        onAbort = () => reject(signal.reason ?? new Error("operation_cancelled"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

export interface DownloadHandle {
  id: string;
  expires_at: string;
}

interface HandleEntry {
  owner: SessionDownloads;
  path: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  expiresAt: number;
}

const handles = new Map<string, HandleEntry>();

function revokeHandlesFor(owner: SessionDownloads): void {
  for (const [id, entry] of handles) if (entry.owner === owner) handles.delete(id);
}

/** A short-lived, single-use bearer for one completed download. */
export function mintDownloadHandle(
  owner: SessionDownloads,
  record: DownloadRecord,
): DownloadHandle {
  if (record.state !== "complete" || record.path === null || record.sha256 === null)
    throw new Error("Only a complete download can be handed out");
  const now = Date.now();
  for (const [id, entry] of handles) if (entry.expiresAt <= now) handles.delete(id);
  const id = `dlh-${randomBytes(24).toString("base64url")}`;
  const expiresAt = now + handleTtlMs();
  handles.set(id, {
    owner,
    path: record.path,
    filename: record.filename,
    size_bytes: record.size_bytes ?? 0,
    sha256: record.sha256,
    expiresAt,
  });
  return { id, expires_at: new Date(expiresAt).toISOString() };
}

export type RedeemedHandle = Omit<HandleEntry, "owner" | "expiresAt">;

/** Consume a handle. Unknown, used, and expired handles all refuse alike. */
export function redeemDownloadHandle(id: string): RedeemedHandle | null {
  const entry = handles.get(id);
  handles.delete(id);
  if (entry === undefined || entry.expiresAt <= Date.now()) return null;
  return {
    path: entry.path,
    filename: entry.filename,
    size_bytes: entry.size_bytes,
    sha256: entry.sha256,
  };
}
