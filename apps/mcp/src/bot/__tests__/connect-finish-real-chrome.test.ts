import { createServer } from "node:net";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import { parse as parseToml } from "smol-toml";
import { openSessionStorage } from "../../session.js";
import type { CeremonyView } from "../broker/ceremony.js";
import { BrokerClient } from "../broker/transport.js";

const TEST_ACCOUNT = "01TESTACCOUNTFINISHPROOF00";
const SESSION_SECRET = "finish-proof-session-secret";
const webDir = fileURLToPath(new URL("../../../../web/", import.meta.url));
const apiDir = fileURLToPath(new URL("../../../../api/src/", import.meta.url));
let browser: Browser | undefined;
let web: ChildProcess | undefined;
let closeApi: (() => Promise<void>) | undefined;
let daemon: ChildProcess | undefined;
let connect: ChildProcess | undefined;
let client: BrokerClient | undefined;
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ts-finish-chrome-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
});

afterEach(async () => {
  await client?.release().catch(() => undefined);
  client = undefined;
  await stopChild(connect);
  connect = undefined;
  await stopChild(daemon);
  daemon = undefined;
  await browser?.close().catch(() => undefined);
  browser = undefined;
  await stopChild(web);
  web = undefined;
  await closeApi?.();
  closeApi = undefined;
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not reached in time");
}

async function unusedPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (address === null || typeof address === "string") throw new Error("missing address");
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

describe("production install Finish in real Chrome", () => {
  it(
    "saves the claimed session and closes sign-in after the production Finish button",
    {
      timeout: 180_000,
    },
    async () => {
      const { buildServer } = await import(`${apiDir}server.ts`);
      const { buildInMemoryDeps } = await import(`${apiDir}services/deps.ts`);
      const { issueSession, signSessionJwt, SESSION_COOKIE_NAME } = await import(
        `${apiDir}auth/session.ts`
      );
      const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET });
      await deps.oauthIdentityStore.create({
        account_id: TEST_ACCOUNT,
        provider: "google",
        provider_user_id: "finish-proof-google",
        email: "finish@example.test",
      });
      const { record, jwt } = issueSession({
        account_id: TEST_ACCOUNT,
        ip: null,
        user_agent: null,
        now: new Date(),
      });
      await deps.sessionStore.insert(record);
      const app = await buildServer({ deps });
      closeApi = () => app.close();
      const apiOrigin = await app.listen({ port: 0, host: "127.0.0.1" });
      const port = await unusedPort();
      const origin = `http://127.0.0.1:${port}`;
      const requireWeb = createRequire(join(webDir, "package.json"));
      let logs = "";
      web = spawn(
        process.execPath,
        [
          requireWeb.resolve("next/dist/bin/next"),
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(port),
        ],
        {
          cwd: webDir,
          env: {
            ...process.env,
            NODE_ENV: "development",
            API_PROXY_TARGET: apiOrigin,
            NEXT_TELEMETRY_DISABLED: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      web.stdout!.on("data", (chunk) => {
        logs += String(chunk);
      });
      web.stderr!.on("data", (chunk) => {
        logs += String(chunk);
      });
      await waitFor(async () => {
        if (web!.exitCode !== null) throw new Error(logs);
        return fetch(`${origin}/install`)
          .then((res) => res.ok)
          .catch(() => false);
      }, 120_000);
      const initiate = await fetch(`${apiOrigin}/v1/mcp/install/initiate`, { method: "POST" });
      expect(initiate.status).toBe(201);
      const { setup_code: code } = (await initiate.json()) as { setup_code: string };
      const profileDir = join(home, ".trusty-squire", "chrome-profile");
      const socket = join(home, "broker.sock");
      const vncPort = await unusedPort();
      await mkdir(join(home, ".trusty-squire"), { recursive: true, mode: 0o700 });
      const requireMcp = createRequire(import.meta.url);
      let daemonLogs = "";
      daemon = spawn(
        process.execPath,
        [
          "--import",
          requireMcp.resolve("tsx"),
          fileURLToPath(new URL("../../bin.ts", import.meta.url)),
          "broker",
        ],
        {
          env: {
            ...process.env,
            NODE_ENV: "test",
            DISPLAY: "",
            BOT_CDP_ENDPOINT: "",
            // x11vnc detects even an empty WAYLAND_DISPLAY as Wayland; this rig uses Xvfb.
            WAYLAND_DISPLAY: undefined,
            XDG_SESSION_TYPE: "x11",
            TRUSTY_SQUIRE_ACCOUNT_ID: "",
            TRUSTY_SQUIRE_BROKER_UNIT: "",
            TRUSTY_SQUIRE_PROFILE_DIR: profileDir,
            TRUSTY_SQUIRE_BROKER_SOCKET: socket,
            TS_LOGIN_PUBLIC_HOSTNAME: "finish-proof.invalid",
            TS_LOGIN_LOCAL_PORT: String(vncPort),
            UNIVERSAL_BOT_CHANNEL: "chrome",
            DBUS_SESSION_BUS_ADDRESS: "",
            XDG_RUNTIME_DIR: join(home, "runtime"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      daemon.stderr!.on("data", (chunk) => {
        daemonLogs += String(chunk);
      });
      daemon.stdout!.on("data", (chunk) => {
        daemonLogs += String(chunk);
      });
      await waitFor(async () => {
        if (daemon!.exitCode !== null) throw new Error(daemonLogs);
        try {
          client = await BrokerClient.connect(socket);
          return true;
        } catch {
          return false;
        }
      });
      const confirmUrl = `${origin}/install?token=${code}&claim=1`;
      const view = await client!.call("ceremony", {
        action: "start",
        confirmUrl,
        setupCode: code,
        apiBase: apiOrigin,
        ttlMs: 120_000,
        callerHasDisplay: false,
        finalize: {
          baseSession: {
            api_base_url: apiOrigin,
            saved_at: new Date().toISOString(),
            machine_token: "tsm_finish_proof",
          },
          applyServerPrefs: true,
          agentConfigs: [{ target: "codex", profileDir, agentIdentity: "codex" }],
        },
      });
      expect(view, daemonLogs).toMatchObject({
        state: "live",
        browser_location: { kind: "virtual" },
      });
      const evidenceDir = process.env.TS_FINISH_EVIDENCE_DIR;
      let connectOutput = "";
      connect = spawn(
        process.execPath,
        [
          "--import",
          requireMcp.resolve("tsx"),
          fileURLToPath(new URL("../../bin.ts", import.meta.url)),
          "connect",
          "--target=codex",
          "--json",
        ],
        {
          env: {
            ...process.env,
            NODE_ENV: "test",
            TRUSTY_SQUIRE_PROFILE_DIR: profileDir,
            TRUSTY_SQUIRE_BROKER_SOCKET: socket,
            TRUSTY_SQUIRE_API_BASE: apiOrigin,
            DBUS_SESSION_BUS_ADDRESS: "",
            XDG_RUNTIME_DIR: join(home, "runtime"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      connect.stdout!.on("data", (chunk) => {
        connectOutput += String(chunk);
      });
      connect.stderr!.on("data", (chunk) => {
        connectOutput += String(chunk);
      });
      await waitFor(() => connect!.exitCode !== null || connect!.signalCode !== null);
      expect(connect.exitCode, connectOutput).toBe(0);
      expect(view).toMatchObject({ state: "live", browser_location: { kind: "virtual" } });
      const vncUrl = (view as Extract<CeremonyView, { state: "live" }>).browser_location;
      if (vncUrl.kind !== "virtual") throw new Error("missing noVNC URL");
      expect(connectOutput).toContain(vncUrl.url);
      if (evidenceDir) await writeFile(join(evidenceDir, "finish-connect.txt"), connectOutput);
      const activePort = await readFile(join(profileDir, "DevToolsActivePort"), "utf8");
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${activePort.split("\n")[0]}`);
      const context = browser.contexts()[0]!;
      const page = context
        .pages()
        .find((candidate) => candidate.url().includes(`/install?token=${code}`));
      expect(page).toBeDefined();
      if (page === undefined) throw new Error(daemonLogs);
      await context.addCookies([
        {
          name: SESSION_COOKIE_NAME,
          value: signSessionJwt(jwt, SESSION_SECRET),
          url: origin,
        },
      ]);
      await page.goto(confirmUrl);
      await waitFor(async () => (await (await openSessionStorage()).read(TEST_ACCOUNT)) !== null);
      expect(page.isClosed()).toBe(false);
      const noVncOrigin = `http://127.0.0.1:${vncPort}`;
      expect((await fetch(noVncOrigin)).ok).toBe(true);
      // The foreground client may exit before the person presses Finish. The
      // daemon must retain both the ceremony and the persisted claim on its own.
      await client!.release();
      client = await BrokerClient.connect(socket);
      const joined = (await client!.call("ceremony", {
        action: "join",
        agentConfigs: [{ target: "hermes" }],
      })) as CeremonyView;
      expect(joined).toMatchObject({
        state: "live",
        confirm_url: confirmUrl,
        reused: true,
      });
      expect(
        context.pages().filter((candidate) => candidate.url().includes(`/install?token=${code}`)),
      ).toHaveLength(1);

      if (evidenceDir)
        await page.screenshot({ path: join(evidenceDir, "finish-ready.png"), fullPage: true });
      // Simulate a transport outage at the browser boundary, using the real
      // wizard and its retry UI. No acknowledgement means no success navigation
      // and no server-side completion; retry must still reach the real route.
      let failedPosts = 0;
      const finishPath = `**/v1/mcp/install/${code}/finish`;
      await page.route(finishPath, async (route) => {
        failedPosts += 1;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"temporary outage"}',
        });
      });
      await page.getByRole("button", { name: "Finish", exact: true }).click();
      const retryAlert = page
        .getByRole("alert")
        .filter({ hasText: "Please press Finish to retry" });
      await retryAlert.waitFor();
      expect(await retryAlert.textContent()).toContain("Please press Finish to retry");
      expect(failedPosts).toBe(3);
      expect(new URL(page.url()).pathname).toBe("/install");
      expect(new URL(page.url()).searchParams.get("token")).toBe(code);
      expect(page.isClosed()).toBe(false);
      expect((await deps.pairingTokenStore.find(code)).finished_at).toBeNull();
      expect(await page.getByRole("button", { name: "Finish", exact: true }).isEnabled()).toBe(
        true,
      );
      if (evidenceDir)
        await page.screenshot({ path: join(evidenceDir, "finish-retry.png"), fullPage: true });
      await page.unroute(finishPath);
      await page.getByRole("button", { name: "Finish", exact: true }).click();
      await waitFor(() => page.isClosed());
      expect((await client!.call("ceremony", { action: "get" })) as CeremonyView).toEqual({
        state: "none",
      });
      await waitFor(async () =>
        fetch(noVncOrigin)
          .then(() => false)
          .catch(() => true),
      );
      expect(daemon!.exitCode).toBeNull();
      expect((await deps.pairingTokenStore.find(code)).finished_at).toBeInstanceOf(Date);
      expect(await (await openSessionStorage()).read(TEST_ACCOUNT)).toMatchObject({
        account_id: TEST_ACCOUNT,
        agent_session_token: expect.any(String),
        machine_token: "tsm_finish_proof",
      });
      const codex = parseToml(await readFile(join(home, ".codex", "config.toml"), "utf8")) as {
        mcp_servers?: { squire?: { env?: Record<string, string> } };
      };
      expect(codex.mcp_servers?.squire?.env).toMatchObject({
        TRUSTY_SQUIRE_ACCOUNT_ID: TEST_ACCOUNT,
        TRUSTY_SQUIRE_PROFILE_DIR: profileDir,
      });
      if (evidenceDir)
        await writeFile(
          join(evidenceDir, "finish-result.json"),
          JSON.stringify(
            {
              observedAt: new Date().toISOString(),
              surface:
                "production daemon, Chrome, noVNC, Next install wizard and Fastify install route; disposable in-memory account",
              foregroundClientDisconnectedBeforeFinish: true,
              connectExitBeforeClaim: connect.exitCode,
              reused: joined.state === "live" && joined.reused,
              failedFinishPosts: failedPosts,
              retryAlert: "Couldn't finish setup. Please press Finish to retry.",
              serverFinishedAt: (await deps.pairingTokenStore.find(code)).finished_at,
              signInPageClosed: page.isClosed(),
              ceremony: await client!.call("ceremony", { action: "get" }),
              noVncReachable: await fetch(noVncOrigin)
                .then(() => true)
                .catch(() => false),
              daemonStillRunning: daemon!.exitCode === null,
              savedAccount: (await (await openSessionStorage()).read(TEST_ACCOUNT))?.account_id,
              codexAccount: codex.mcp_servers?.squire?.env?.TRUSTY_SQUIRE_ACCOUNT_ID,
            },
            null,
            2,
          ),
        );
    },
  );
});
