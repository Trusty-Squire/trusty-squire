import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api-client.js";
import type * as JevClient from "../jev-client.js";
import type { JevQuestion } from "../jev-client.js";

// The drive asks this fake model. It always picks the download button, the
// way a model that cannot see the finished download would.
const jev = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../jev-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof JevClient>();
  return {
    ...actual,
    askJev: async (_api: unknown, _state: unknown, questions: Record<string, JevQuestion>) => {
      jev.calls += 1;
      const clickCriteria =
        questions.CLICK_target?.type === "choice" ? questions.CLICK_target.criteria : {};
      const target =
        Object.entries(clickCriteria).find(([, label]) =>
          label.includes("Download the file"),
        )?.[0] ?? Object.keys(clickCriteria)[0]!;
      const choices: Record<string, string> = { operation: "CLICK", CLICK_target: target };
      const answers = Object.fromEntries(
        Object.entries(choices).map(([name, choice]) => {
          const question = questions[name];
          const keys = question?.type === "choice" ? Object.keys(question.criteria) : [];
          return [
            name,
            {
              choice,
              confidence: 0.95,
              probabilities: Object.fromEntries(
                keys.map((key) => [
                  key,
                  keys.length === 1 ? 1 : key === choice ? 0.95 : 0.05 / (keys.length - 1),
                ]),
              ),
            },
          ];
        }),
      );
      return { attempts: 1, elapsedMs: 1, result: { answers } };
    },
  };
});

import { BrowserController } from "../browser.js";
import { BrokerAuthority, type BrokerPrincipal } from "../broker/authority.js";
import { listenSharedMcp } from "../broker/mcp-socket.js";
import type { OperatorBroker } from "../broker/operator.js";
import { fetchDownloadHandle } from "../download-transfer.js";
import type { DownloadRecord } from "../downloads.js";
import { finishProvisionSession, startHarnessProvisionSession } from "../provision-session.js";
import { sessionForCall } from "../session/lifecycle.js";
import {
  operateClickTool,
  operateDownloadTool,
  operateDriveTool,
  operateNavigateTool,
  provisionObserveTool,
} from "../../tools/provision-drive.js";

const FILE = randomBytes(5 * 1024 * 1024);
const FILE_SHA256 = createHash("sha256").update(FILE).digest("hex");
const PAGE = `<!doctype html><meta charset="utf-8"><title>Downloads</title>
<main><h1>Clip</h1>
<button type="button" onclick="location.href='/file'">Download the file</button>
<button type="button" onclick="location.href='/broken'">Download the broken file</button></main>`;

let browser: Browser;
let server: Server;
let origin: string;
let root: string;
const hits = { file: 0, broken: 0 };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ts-operator-download-"));
  process.env.TRUSTY_SQUIRE_DOWNLOADS_DIR = join(root, "broker-downloads");
  server = createServer((req, res) => {
    if (req.url === "/file") {
      hits.file += 1;
      res.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": String(FILE.length),
        "content-disposition": 'attachment; filename="clip.mp4"',
      });
      res.end(FILE);
      return;
    }
    if (req.url === "/broken") {
      // Every attempt breaks off, including Chrome's automatic retries.
      hits.broken += 1;
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(FILE.length),
        "content-disposition": 'attachment; filename="broken.zip"',
      });
      res.write(FILE.subarray(0, 64 * 1024), () => setTimeout(() => res.destroy(), 200));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no fixture port");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.TRUSTY_SQUIRE_DOWNLOADS_DIR;
  delete process.env.TRUSTY_SQUIRE_DOWNLOAD_HANDLE_TTL_MS;
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  hits.file = 0;
  hits.broken = 0;
  jev.calls = 0;
});

type Rows = Array<[string, string, string?]>;

async function session(from: Browser = browser): Promise<{
  id: string;
  rows: Rows;
  context: BrowserContext;
  close: () => Promise<void>;
}> {
  const context = await from.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}/`);
  const started = await startHarnessProvisionSession({
    browser: BrowserController.fromHarnessPage(page),
    serviceUrl: `${origin}/`,
    format: "compact",
  });
  return {
    id: started.session_id,
    rows: (started as unknown as { safe_table: Rows }).safe_table,
    context,
    close: async () => {
      await finishProvisionSession(started.session_id);
      await context.close();
    },
  };
}

function ref(rows: Rows, label: string): string {
  const row = rows.find((candidate) => candidate[2]?.split("|")[0] === label);
  if (row === undefined) throw new Error(`missing ${label} in ${JSON.stringify(rows)}`);
  return row[0];
}

async function clickDownload(
  id: string,
  rows: Rows,
  label = "@download-the-file",
): Promise<DownloadRecord[]> {
  const result = (await operateClickTool.handler(
    { session_id: id, ref: ref(rows, label) },
    null,
  )) as { downloads?: DownloadRecord[] };
  return result.downloads ?? [];
}

it("reports a click's download and delivers it with a matching sha256", async () => {
  const s = await session();
  const agentDir = await mkdtemp(join(root, "agent-"));
  try {
    const downloads = await clickDownload(s.id, s.rows);
    expect(downloads).toHaveLength(1);
    const record = downloads[0]!;
    expect(record).toMatchObject({
      state: "complete",
      filename: "clip.mp4",
      mime_type: "video/mp4",
      size_bytes: FILE.length,
      sha256: FILE_SHA256,
    });
    expect(record.download_id).toMatch(/^dl-/);
    expect(record.path).toMatch(new RegExp(`^${process.env.TRUSTY_SQUIRE_DOWNLOADS_DIR}/session-`));
    expect((await stat(record.path!)).size).toBe(FILE.length);
    expect(hits.file).toBe(1);

    const delivered = (await operateDownloadTool.handler(
      { session_id: s.id, download_id: record.download_id, dest_dir: agentDir, timeout_ms: 30_000 },
      null,
    )) as { status: string; delivered: { path: string; sha256: string; size_bytes: number } };
    expect(delivered.status).toBe("delivered");
    expect(delivered.delivered).toEqual({
      path: join(agentDir, "clip.mp4"),
      sha256: FILE_SHA256,
      size_bytes: FILE.length,
    });
    expect(
      createHash("sha256")
        .update(await readFile(delivered.delivered.path))
        .digest("hex"),
    ).toBe(FILE_SHA256);

    // The next step does not repeat a record that has not changed.
    const observed = (await provisionObserveTool.handler({ session_id: s.id }, null)) as {
      downloads?: unknown;
    };
    expect(observed.downloads).toBeUndefined();

    // The session folder ends with the session.
    const folder = join(record.path!, "..", "..");
    await s.close();
    await vi.waitFor(async () => {
      await expect(stat(folder)).rejects.toThrow();
    });
  } finally {
    if (sessionForCall(s.id) !== undefined) await s.close();
  }
}, 60_000);

it("reports a broken download as failed", async () => {
  const s = await session();
  try {
    const downloads = await clickDownload(s.id, s.rows, "@download-the-broken-file");
    expect(hits.broken).toBeGreaterThanOrEqual(1);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatchObject({
      state: "failed",
      filename: "broken.zip",
      mime_type: "application/zip",
      path: null,
      sha256: null,
    });
  } finally {
    await s.close();
  }
}, 60_000);

it("completes a 'download the file' drive after one download", async () => {
  const s = await session();
  try {
    const result = (await operateDriveTool.handler(
      { session_id: s.id, goal: "download the file", max_steps: 8, max_seconds: 30 },
      { useCredential: vi.fn() } as unknown as ApiClient,
    )) as { status: string; reason?: string; downloads?: DownloadRecord[] };
    expect(result.status).toBe("complete");
    expect(result.reason).toMatch(/^Downloaded clip\.mp4/);
    expect(jev.calls).toBe(1);
    expect(hits.file).toBe(1);
    expect(result.downloads).toHaveLength(1);
    expect(result.downloads![0]).toMatchObject({ state: "complete", sha256: FILE_SHA256 });
  } finally {
    await s.close();
  }
}, 60_000);

it("answers chrome://downloads with an operate_download hint", async () => {
  // The headless shell has no chrome:// pages; full Chromium does, like the
  // operator's Chrome.
  const full = await chromium.launch({
    channel: "chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const s = await session(full);
  try {
    await operateNavigateTool.handler({ session_id: s.id, url: "chrome://downloads" }, null);
    const observed = (await provisionObserveTool.handler({ session_id: s.id }, null)) as {
      url: string;
      guidance?: string;
      page_readiness?: unknown;
    };
    expect(observed.url).toBe("chrome://downloads/");
    expect(observed.guidance).toMatch(/Use operate_download/);
    expect(observed.page_readiness).toBeUndefined();
  } finally {
    await s.close();
    await full.close();
  }
}, 60_000);

it("refuses a download id to another session and another owner", async () => {
  const first = await session();
  const second = await session();
  const authority = new BrokerAuthority();
  const owner: BrokerPrincipal = { agentId: "owner", clientId: "owner-client" };
  const stranger: BrokerPrincipal = { agentId: "stranger", clientId: "stranger-client" };
  try {
    const [record] = await clickDownload(first.id, first.rows);
    const args = { download_id: record!.download_id, timeout_ms: 1_000 };

    await expect(
      operateDownloadTool.handler({ ...args, session_id: second.id }, null),
    ).rejects.toThrow(/unknown_download/);

    const brokerId = await authority.open(owner, async () => ({
      targetId: "target",
      invoke: async (name, commandArgs) => {
        if (name !== "operate_download") throw new Error("unexpected command");
        return await operateDownloadTool.handler(
          { ...(commandArgs as typeof args), session_id: first.id },
          null,
        );
      },
      close: async () => true,
      orphan: async () => undefined,
    }));
    await expect(
      (async () => await authority.invoke(stranger, brokerId, "r1", "operate_download", args))(),
    ).rejects.toMatchObject({ code: "stale_lease" });
    await expect(
      authority.invoke(owner, brokerId, "r2", "operate_download", args),
    ).resolves.toMatchObject({ status: "handle" });
  } finally {
    await first.close();
    await second.close();
  }
}, 60_000);

it("hands a remote agent a short-lived handle that yields the same file", async () => {
  const s = await session();
  const socketDir = await mkdtemp(join(root, "sock-"));
  const socketPath = join(socketDir, "mcp.sock");
  const listener = await listenSharedMcp({} as OperatorBroker, socketPath);
  const remoteDir = await mkdtemp(join(root, "remote-agent-"));
  try {
    const [record] = await clickDownload(s.id, s.rows);
    const request = {
      session_id: s.id,
      download_id: record!.download_id,
      delivery: "handle" as const,
      timeout_ms: 30_000,
    };
    const minted = (await operateDownloadTool.handler(request, null)) as {
      status: string;
      handle: { id: string; expires_at: string; fetch_command: string };
    };
    expect(minted.status).toBe("handle");
    expect(Date.parse(minted.handle.expires_at)).toBeGreaterThan(Date.now());
    expect(minted.handle.fetch_command).toContain(`download ${minted.handle.id}`);

    const fetched = await fetchDownloadHandle(socketPath, minted.handle.id, remoteDir);
    expect(fetched).toEqual({
      path: join(remoteDir, "clip.mp4"),
      size_bytes: FILE.length,
      sha256: FILE_SHA256,
    });
    expect(
      createHash("sha256")
        .update(await readFile(fetched.path))
        .digest("hex"),
    ).toBe(FILE_SHA256);
    // Single use.
    await expect(fetchDownloadHandle(socketPath, minted.handle.id, remoteDir)).rejects.toThrow(
      /unknown_or_expired_handle/,
    );

    // Expired.
    process.env.TRUSTY_SQUIRE_DOWNLOAD_HANDLE_TTL_MS = "200";
    const shortLived = (await operateDownloadTool.handler(request, null)) as {
      handle: { id: string };
    };
    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect(fetchDownloadHandle(socketPath, shortLived.handle.id, remoteDir)).rejects.toThrow(
      /unknown_or_expired_handle/,
    );
  } finally {
    delete process.env.TRUSTY_SQUIRE_DOWNLOAD_HANDLE_TTL_MS;
    await listener.close();
    await s.close();
  }
}, 60_000);
