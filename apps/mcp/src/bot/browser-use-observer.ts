// Thin, read-only adapter around the pinned browser-use Python serializer.
// Browser-use owns DOM candidate selection; this module only manages a single
// JSONL subprocess and returns its process-internal selector-map hints.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { BrowserUseSelectedNode } from "./compact-observation-v2.js";

interface BridgeResponse {
  ok: boolean;
  selected?: BrowserUseSelectedNode[];
}

// Browser-use's maintained serializer may need several seconds on a first
// large-SPA snapshot. Falling back at 2s emitted the legacy V1 payload (often
// tens of KB), defeating the hard V2 budget. This is an availability timeout,
// not a response budget: the sealed V2 result remains capped independently.
const SERIALIZER_TIMEOUT_MS = 30_000;

class BrowserUseObserver {
  private child: ChildProcess | null = null;
  private pending: Array<(response: BridgeResponse) => void> = [];
  private buffer = "";

  private scriptPath(): string {
    // `dist/bot` and `src/bot` are both two segments below the package root.
    return resolve(dirname(fileURLToPath(import.meta.url)), "../../assets/browser-use-observe.py");
  }

  private ensureStarted(): ChildProcess | null {
    if (this.child !== null && this.child.exitCode === null) return this.child;
    const python = process.env.TRUSTY_SQUIRE_BROWSER_USE_PYTHON ?? "python3";
    try {
      const child = spawn(python, [this.scriptPath()], {
        stdio: ["pipe", "pipe", "ignore"],
        // The bridge only needs the installed Python environment and its stdin.
        // Do not forward app credentials or network configuration into it.
        env: {
          PATH: process.env.PATH ?? "",
          PYTHONUNBUFFERED: "1",
          ANONYMIZED_TELEMETRY: "false",
          BROWSER_USE_CLOUD_SYNC: "false",
        },
      });
      if (child.stdout === null || child.stdin === null) return null;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.onData(chunk));
      child.on("exit", () => {
        this.child = null;
        const pending = this.pending.splice(0);
        pending.forEach((resolvePending) => resolvePending({ ok: false }));
      });
      child.on("error", () => undefined);
      this.child = child;
      return child;
    } catch {
      return null;
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const resolvePending = this.pending.shift();
      if (resolvePending === undefined) continue;
      try {
        const response = JSON.parse(line) as BridgeResponse;
        resolvePending(
          response.ok === true && Array.isArray(response.selected)
            ? { ok: true, selected: response.selected }
            : { ok: false },
        );
      } catch {
        resolvePending({ ok: false });
      }
    }
  }

  async observe(cdpUrl: string): Promise<BrowserUseSelectedNode[] | null> {
    const child = this.ensureStarted();
    if (child === null || !cdpUrl.startsWith("http")) return null;
    const response = await new Promise<BridgeResponse>((resolveResponse) => {
      const timeout = setTimeout(() => resolveResponse({ ok: false }), SERIALIZER_TIMEOUT_MS);
      this.pending.push((response) => {
        clearTimeout(timeout);
        resolveResponse(response);
      });
      try {
        child.stdin?.write(`${JSON.stringify({ kind: "observe", cdp_url: cdpUrl })}\n`);
      } catch {
        clearTimeout(timeout);
        resolveResponse({ ok: false });
      }
    });
    return response.ok === true && response.selected !== undefined ? response.selected : null;
  }

  close(): void {
    this.child?.kill();
    this.child = null;
  }
}

const observer = new BrowserUseObserver();

export async function observeWithBrowserUse(cdpUrl: string | null): Promise<BrowserUseSelectedNode[] | null> {
  return cdpUrl === null ? null : await observer.observe(cdpUrl);
}

export function closeBrowserUseObserver(): void {
  observer.close();
}
