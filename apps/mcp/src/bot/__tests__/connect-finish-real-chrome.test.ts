// Required-tier gate for the connect sign-in Finish (owner decision, 2026-11-22):
// a PR that breaks Finish must not merge. This is the one real-browser test that
// deliberately runs on every pull request (see REAL_BROWSER_FILES in
// vitest.tiers.ts), so it stays small: one real Chrome page, no noVNC helpers.
//
// What is real: Google Chrome (system `channel: "chrome"`, preinstalled on the
// CI runner), the person's clicks on the install page, the daemon's ceremony
// host, its `/status` reader, and the claim's on-disk landing (session file,
// broker account binding, host-agent MCP config) in a sandboxed HOME. The
// install routes are served here following the API's install contract
// (`/claim`, `/status` delivering the token once then reporting `delivered`,
// `/finish` refusing before the claim); apps/api's own suite pins that
// contract against the real route, and apps/web's suite pins the wizard's
// same-origin Finish POST. The noVNC exposure is a recorder, because the
// helpers are not installed on CI; its `stop` is the window closing.
//
// Oracle: the owner's reported failure — "when I pressed finish at signup, the
// signup sequence never finishes and the novnc page does not close" — with no
// connect process running. A broken Finish leaves the page open, the exposure
// running, or no session on disk.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import { parse as parseToml } from "smol-toml";
import { openSessionStorage } from "../../session.js";
import {
  BrokerCeremonyHost,
  pollInstallStatus,
  type CeremonyStartRequest,
  type CeremonyTab,
} from "../broker/ceremony.js";
import {
  finalizeCeremonyClaim,
  writeCeremonyAgentConfigs,
} from "../../install/ceremony-finalize.js";

const SETUP_CODE = "finish-proof-code";
const TEST_ACCOUNT = "01TESTACCOUNTFINISHPROOF00";
const AGENT_TOKEN = "ts_agent_finish_proof";

interface InstallRecord {
  status: "pending" | "claimed" | "delivered";
  finished: boolean;
}

// The install page the bot's Chrome shows: sign in, then Finish. Finish is a
// same-origin POST to /finish, then the done page — the wizard's shape.
function installPage(code: string): string {
  return `<!doctype html><html><body>
<h1>Set up Trusty Squire</h1>
<button id="sign-in">Continue with Google</button>
<button id="finish" hidden>Finish</button>
<script>
const code = ${JSON.stringify(code)};
document.getElementById("sign-in").onclick = async () => {
  const res = await fetch("/v1/mcp/install/" + encodeURIComponent(code) + "/claim", { method: "POST" });
  if (res.ok) document.getElementById("finish").hidden = false;
};
document.getElementById("finish").onclick = async () => {
  await fetch("/v1/mcp/install/" + encodeURIComponent(code) + "/finish", { method: "POST" });
  location.assign("/install/done");
};
</script></body></html>`;
}

function installServer(record: InstallRecord): Server {
  return createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const route = url.pathname.match(/^\/v1\/mcp\/install\/([^/]+)\/(claim|status|finish)$/);
    if (req.method === "GET" && url.pathname === "/install") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(installPage(url.searchParams.get("token") ?? ""));
      return;
    }
    if (req.method === "GET" && url.pathname === "/install/done") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<h1>Connected</h1>");
      return;
    }
    if (route === null || decodeURIComponent(route[1]!) !== SETUP_CODE) {
      send(404, { error: "not_found" });
      return;
    }
    const action = route[2];
    if (action === "claim" && req.method === "POST") {
      if (record.status !== "pending") return send(409, { error: "not_pending" });
      record.status = "claimed";
      return send(200, { ok: true, account_id: TEST_ACCOUNT });
    }
    if (action === "finish" && req.method === "POST") {
      if (record.status === "pending") return send(409, { error: "not_claimed" });
      record.finished = true;
      return send(200, { ok: true });
    }
    if (action === "status" && req.method === "GET") {
      if (record.status === "pending") return send(200, { status: "pending" });
      if (record.status === "claimed") {
        // The raw token is delivered exactly once.
        record.status = "delivered";
        return send(200, {
          status: "claimed",
          agent_session_token: AGENT_TOKEN,
          account_id: TEST_ACCOUNT,
          install_preferences: { registry_enabled: false, consent_operator_inbox_otp: true },
          finished: record.finished,
        });
      }
      return send(200, {
        status: "delivered",
        account_id: TEST_ACCOUNT,
        finished: record.finished,
      });
    }
    send(405, { error: "method_not_allowed" });
  });
}

let browser: Browser | undefined;
let server: Server | undefined;
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ts-finish-chrome-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await browser?.close().catch(() => undefined);
  browser = undefined;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  await rm(home, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not reached in time");
}

describe("connect sign-in Finish in a real Chrome", () => {
  it(
    "saves the session on sign-in and closes the sign-in window when Finish is pressed",
    { timeout: 60_000 },
    async () => {
      const record: InstallRecord = { status: "pending", finished: false };
      server = installServer(record);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const profileDir = join(home, ".trusty-squire", "chrome-profile");

      browser = await chromium.launch({ channel: "chrome", headless: true });
      const context = await browser.newContext();
      const openTab = async (url: string): Promise<CeremonyTab> => {
        const page = await context.newPage();
        await page.goto(url);
        return {
          command: async (name, args) =>
            name === "operate_ceremony_window" && args.action === "show_phone"
              ? { left: 0, top: 0, width: 400, height: 800 }
              : {},
          close: async () => await page.close(),
        };
      };
      const stopExposure = vi.fn(async () => undefined);
      const host = new BrokerCeremonyHost({
        profileDir,
        openTab,
        logoutProviders: async () => undefined,
        expose: async ({ windowControl }) => {
          await windowControl.showPhone();
          return { kind: "exposed", url: "https://novnc.invalid/#p=pw", stop: stopExposure };
        },
        pollStatus: pollInstallStatus,
        finalize: finalizeCeremonyClaim,
        writeAgentConfigs: writeCeremonyAgentConfigs,
        detectProviders: async () => ["google"],
        log: () => undefined,
        pollIntervalMs: 100,
      });
      const request: CeremonyStartRequest = {
        action: "start",
        confirmUrl: `${origin}/install?token=${SETUP_CODE}`,
        setupCode: SETUP_CODE,
        apiBase: origin,
        ttlMs: 60_000,
        callerHasDisplay: false,
        finalize: {
          baseSession: {
            api_base_url: origin,
            saved_at: new Date().toISOString(),
            machine_token: "tsm_finish_proof",
          },
          applyServerPrefs: true,
          agentConfigs: [{ target: "codex", agentIdentity: "codex", profileDir }],
        },
      };

      // connect's request returns as soon as the window is up; nothing waits on it.
      const view = await host.call(request);
      expect(view).toMatchObject({
        state: "live",
        browser_location: { kind: "virtual", url: "https://novnc.invalid/#p=pw" },
      });
      const installTabs = () => context.pages().filter((p) => p.url().includes("/install?token="));
      expect(installTabs()).toHaveLength(1);

      // A second connect while it is live gets the same window, not a second tab.
      await expect(
        host.call({ ...request, setupCode: "second-connect-code" }),
      ).resolves.toMatchObject({ state: "live", confirm_url: request.confirmUrl, reused: true });
      expect(installTabs()).toHaveLength(1);

      // The person signs in. The claim lands on disk while the window stays open
      // for the optional GitHub step.
      const page = installTabs()[0]!;
      await page.click("#sign-in");
      await waitFor(async () => (await (await openSessionStorage()).read(TEST_ACCOUNT)) !== null);
      expect(page.isClosed()).toBe(false);
      expect(stopExposure).not.toHaveBeenCalled();
      expect(host.current()).toMatchObject({ state: "live" });

      // Finish.
      await page.click("#finish");
      await waitFor(() => host.current().state === "none");
      expect(record.finished).toBe(true);
      expect(stopExposure).toHaveBeenCalledTimes(1);
      expect(page.isClosed()).toBe(true);
      expect(installTabs()).toHaveLength(0);

      // What the MCP server will read back: the session, and the host agent's
      // config pinned to the claimed account.
      expect(await (await openSessionStorage()).read(TEST_ACCOUNT)).toMatchObject({
        account_id: TEST_ACCOUNT,
        agent_session_token: AGENT_TOKEN,
        machine_token: "tsm_finish_proof",
      });
      const codex = parseToml(await readFile(join(home, ".codex", "config.toml"), "utf8")) as {
        mcp_servers?: { squire?: { env?: Record<string, string> } };
      };
      expect(codex.mcp_servers?.squire?.env).toMatchObject({
        TRUSTY_SQUIRE_ACCOUNT_ID: TEST_ACCOUNT,
        TRUSTY_SQUIRE_PROFILE_DIR: profileDir,
      });
    },
  );
});
