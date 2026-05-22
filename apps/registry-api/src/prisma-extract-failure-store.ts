import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  createRegistryPrismaClient,
  type RegistryPrismaClient,
} from "./registry-prisma-client.js";
import {
  MAX_HTML_BYTES,
  MAX_SCREENSHOT_BYTES,
  RateLimitedError,
  SNAPSHOT_RETENTION_MS,
  TooLargeError,
  UPLOAD_RATE_LIMIT_PER_HOUR,
  UPLOAD_RATE_LIMIT_WINDOW_MS,
  type ExtractFailureDetail,
  type ExtractFailureStore,
  type ExtractFailureSummary,
  type ExtractFailureUpload,
} from "./extract-failure-store.js";

export class PrismaExtractFailureStore implements ExtractFailureStore {
  private constructor(private readonly client: RegistryPrismaClient) {}

  static async fromEnv(): Promise<PrismaExtractFailureStore> {
    const client = createRegistryPrismaClient();
    await client.$connect();
    return new PrismaExtractFailureStore(client);
  }

  async disconnect(): Promise<void> {
    await this.client.$disconnect();
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

    const now = new Date();
    const windowStart = new Date(now.getTime() - UPLOAD_RATE_LIMIT_WINDOW_MS);
    const recent = await this.client.extractFailureSnapshot.count({
      where: { account_id, uploaded_at: { gte: windowStart } },
    });
    if (recent >= UPLOAD_RATE_LIMIT_PER_HOUR) {
      const oldestRows = await this.client.extractFailureSnapshot.findMany({
        where: { account_id, uploaded_at: { gte: windowStart } },
        orderBy: { uploaded_at: "asc" },
        take: 1,
      });
      const oldest = (oldestRows[0] as ExtractFailureRow | undefined)?.uploaded_at ?? now;
      const retry_after_seconds = Math.ceil(
        (oldest.getTime() + UPLOAD_RATE_LIMIT_WINDOW_MS - now.getTime()) / 1000,
      );
      throw new RateLimitedError(Math.max(1, retry_after_seconds));
    }

    const row = (await this.client.extractFailureSnapshot.create({
      data: {
        id: randomUUID(),
        account_id,
        service: payload.service,
        mcp_version: payload.mcp_version,
        expires_at: new Date(now.getTime() + SNAPSHOT_RETENTION_MS),
        url: payload.url,
        title: payload.title,
        step_label: payload.step_label,
        extract_reason: payload.extract_reason,
        candidates_json: payload.candidates,
        html_gzip: gzipSync(Buffer.from(payload.html, "utf8")),
        screenshot_jpeg,
        html_bytes,
        screenshot_bytes,
      },
    })) as ExtractFailureRow;
    return toSummary(row);
  }

  async list(account_id: string, limit = 50): Promise<ExtractFailureSummary[]> {
    await this.pruneExpired();
    const rows = await this.client.extractFailureSnapshot.findMany({
      where: { account_id, expires_at: { gt: new Date() } },
      orderBy: { uploaded_at: "desc" },
      take: Math.min(limit, 200),
    });
    return rows.map((row) => toSummary(row as ExtractFailureRow));
  }

  async get(account_id: string, id: string): Promise<ExtractFailureDetail | null> {
    const row = (await this.client.extractFailureSnapshot.findFirst({
      where: { id, account_id, expires_at: { gt: new Date() } },
    })) as ExtractFailureRow | null;
    if (row === null) return null;
    return {
      ...toSummary(row),
      html: gunzipSync(row.html_gzip).toString("utf8"),
      screenshot_jpeg: row.screenshot_jpeg,
      candidates: Array.isArray(row.candidates_json)
        ? row.candidates_json.filter((value): value is string => typeof value === "string")
        : [],
    };
  }

  async pruneExpired(now = new Date()): Promise<number> {
    const result = await this.client.extractFailureSnapshot.deleteMany({
      where: { expires_at: { lte: now } },
    });
    return result.count;
  }
}

type ExtractFailureRow = {
  id: string;
  service: string;
  mcp_version: string;
  uploaded_at: Date;
  expires_at: Date;
  url: string;
  title: string;
  step_label: string;
  extract_reason: string;
  candidates_json: unknown;
  html_gzip: Buffer;
  screenshot_jpeg: Buffer | null;
  html_bytes: number;
  screenshot_bytes: number;
};

function toSummary(row: ExtractFailureRow): ExtractFailureSummary {
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
  };
}
