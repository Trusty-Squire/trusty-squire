import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAIN_LOGIN_BROWSER_QUIT_SIGNAL, quitPlainLoginBrowser } from "../browser.js";
import { resolveChannelBinary } from "../browser.js";

// Regression: `connect` established a real Google session in the bot's Chrome
// profile and then threw it away. Chrome routes SIGTERM to its "session
// ending" path — an abrupt exit that does NOT flush the SQLite cookie store,
// whose own commit timer is ~30s out — and the login browser is quit within a
// couple of seconds of the OAuth dance finishing. The result was exactly what
// the operator saw: claim succeeds, session file written, provider probe
// truthfully reports "Google not connected". Verified against real Chrome on
// 2026-09-04: a cookie set 6s before the signal survives SIGINT and is lost on
// SIGTERM, for both a bare pid and a process-group signal.
describe("quitPlainLoginBrowser", () => {
  it("quits with SIGINT, never SIGTERM", async () => {
    const signals: NodeJS.Signals[] = [];
    await quitPlainLoginBrowser({
      signalQuit: (signal) => {
        signals.push(signal);
        return true;
      },
      isRunning: () => false,
      finalize: async () => undefined,
    });
    expect(signals).toEqual(["SIGINT"]);
    expect(PLAIN_LOGIN_BROWSER_QUIT_SIGNAL).toBe("SIGINT");
  });

  it("does not run the reaper handover while Chrome is still shutting down", async () => {
    // The reaper escalates SIGTERM -> SIGKILL, so handing over mid-flush
    // reintroduces the abrupt exit the signal choice exists to avoid.
    const order: string[] = [];
    let alive = true;
    let polls = 0;
    await quitPlainLoginBrowser({
      signalQuit: (signal) => {
        order.push(`signal:${signal}`);
        return true;
      },
      isRunning: () => {
        if (polls >= 3) alive = false;
        return alive;
      },
      finalize: async () => {
        order.push("finalize");
      },
      pollMs: 0,
      wait: async () => {
        polls += 1;
      },
    });
    expect(order).toEqual(["signal:SIGINT", "finalize"]);
    expect(polls).toBe(3);
    expect(alive).toBe(false);
  });

  it("hands over immediately when the quit signal could not be delivered", async () => {
    const order: string[] = [];
    let waits = 0;
    await quitPlainLoginBrowser({
      signalQuit: () => false,
      isRunning: () => true,
      finalize: async () => {
        order.push("finalize");
      },
      pollMs: 0,
      wait: async () => {
        waits += 1;
      },
    });
    expect(order).toEqual(["finalize"]);
    expect(waits).toBe(0);
  });

  it("hands over to the reaper when the graceful quit outlasts its deadline", async () => {
    const order: string[] = [];
    let waits = 0;
    await quitPlainLoginBrowser({
      signalQuit: () => true,
      isRunning: () => true,
      finalize: async () => {
        order.push("finalize");
      },
      deadlineMs: 5,
      pollMs: 0,
      wait: async () => {
        waits += 1;
        await new Promise((resolve) => setTimeout(resolve, 2));
      },
    });
    expect(order).toEqual(["finalize"]);
    expect(waits).toBeGreaterThan(0);
  });
});

// The fact the fix rests on, checked against REAL Chrome rather than asserted
// from a comment: a cookie written moments before the quit survives
// PLAIN_LOGIN_BROWSER_QUIT_SIGNAL. Flip that constant back to SIGTERM and this
// fails — the cookie store is never flushed and the profile comes back empty.
// Opt-in (needs Chrome + an X display or Xvfb): RUN_LIVE_CHROME_QUIT=1.
describe.skipIf(process.env.RUN_LIVE_CHROME_QUIT !== "1")("live Chrome cookie flush", () => {
  it("keeps a just-set cookie across the quit signal", async () => {
    const binary = resolveChannelBinary("chrome");
    expect(binary).not.toBeNull();
    const profileDir = mkdtempSync(join(tmpdir(), "ts-quit-probe-"));
    const server = createServer((_req, res) => {
      res.setHeader("Set-Cookie", "ts_probe=hello; Max-Age=86400; Path=/");
      res.setHeader("Content-Type", "text/html");
      res.end("<html><body>cookie set</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no test server port");
    try {
      const child = spawn(
        binary!,
        [
          `--user-data-dir=${profileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--password-store=basic",
          "--no-sandbox",
          "--disable-dev-shm-usage",
          `--app=http://127.0.0.1:${address.port}/`,
        ],
        { detached: true, stdio: "ignore" },
      );
      let exited = false;
      child.on("exit", () => {
        exited = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      await quitPlainLoginBrowser({
        signalQuit: (signal) => {
          child.kill(signal);
          return true;
        },
        isRunning: () => !exited,
        finalize: async () => undefined,
      });
      const { default: Database } = await import("better-sqlite3");
      const db = new Database(join(profileDir, "Default", "Cookies"), { readonly: true });
      const rows = db.prepare("select name from cookies").all() as Array<{ name: string }>;
      db.close();
      expect(rows.map((row) => row.name)).toContain("ts_probe");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(profileDir, { recursive: true, force: true });
    }
  }, 60_000);
});
