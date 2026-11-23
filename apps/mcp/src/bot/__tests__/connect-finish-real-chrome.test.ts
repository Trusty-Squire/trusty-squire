import { createServer } from "node:net";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import { parse as parseToml } from "smol-toml";
import { openSessionStorage } from "../../session.js";
import { BrokerCeremonyHost, pollInstallStatus, type CeremonyTab } from "../broker/ceremony.js";
import { finalizeCeremonyClaim, writeCeremonyAgentConfigs } from "../../install/ceremony-finalize.js";

const TEST_ACCOUNT = "01TESTACCOUNTFINISHPROOF00";
const SESSION_SECRET = "finish-proof-session-secret";
const webDir = fileURLToPath(new URL("../../../../web/", import.meta.url));
const apiDir = fileURLToPath(new URL("../../../../api/src/", import.meta.url));
let browser: Browser | undefined;
let web: ChildProcess | undefined;
let closeApi: (() => Promise<void>) | undefined;
let host: BrokerCeremonyHost | undefined;
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ts-finish-chrome-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
});

afterEach(async () => {
  await host?.shutdown();
  host = undefined;
  await browser?.close();
  browser = undefined;
  if (web !== undefined && web.exitCode === null) {
    const exited = new Promise<void>((resolve) => web!.once("exit", () => resolve()));
    web.kill("SIGTERM");
    await exited;
  }
  web = undefined;
  await closeApi?.();
  closeApi = undefined;
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

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
  it("saves the claimed session and closes sign-in after the production Finish button", {
    timeout: 180_000,
  }, async () => {
    const { buildServer } = await import(`${apiDir}server.ts`);
    const { buildInMemoryDeps } = await import(`${apiDir}services/deps.ts`);
    const { issueSession, signSessionJwt, SESSION_COOKIE_NAME } = await import(`${apiDir}auth/session.ts`);
    const deps = buildInMemoryDeps({ sessionSecret: SESSION_SECRET });
    await deps.oauthIdentityStore.create({
      account_id: TEST_ACCOUNT, provider: "google", provider_user_id: "finish-proof-google",
      email: "finish@example.test",
    });
    const { record, jwt } = issueSession({
      account_id: TEST_ACCOUNT, ip: null, user_agent: null, now: new Date(),
    });
    await deps.sessionStore.insert(record);
    const app = await buildServer({ deps });
    closeApi = () => app.close();
    const apiOrigin = await app.listen({ port: 0, host: "127.0.0.1" });
    const port = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    const requireWeb = createRequire(join(webDir, "package.json"));
    let logs = "";
    web = spawn(process.execPath, [requireWeb.resolve("next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: webDir,
      env: { ...process.env, NODE_ENV: "development", API_PROXY_TARGET: apiOrigin, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    web.stdout!.on("data", (chunk) => { logs += String(chunk); });
    web.stderr!.on("data", (chunk) => { logs += String(chunk); });
    await waitFor(async () => {
      if (web!.exitCode !== null) throw new Error(logs);
      return fetch(`${origin}/install`).then((res) => res.ok).catch(() => false);
    }, 120_000);
    const initiate = await fetch(`${apiOrigin}/v1/mcp/install/initiate`, { method: "POST" });
    expect(initiate.status).toBe(201);
    const { setup_code: code } = await initiate.json() as { setup_code: string };
    const profileDir = join(home, ".trusty-squire", "chrome-profile");
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext();
    await context.addCookies([{
      name: SESSION_COOKIE_NAME, value: signSessionJwt(jwt, SESSION_SECRET), url: origin,
    }]);
    const openTab = async (url: string): Promise<CeremonyTab> => {
      const page = await context.newPage();
      await page.goto(url);
      return { command: async () => ({}), close: async () => page.close() };
    };
    const stopExposure = vi.fn(async () => undefined);
    host = new BrokerCeremonyHost({
      profileDir, openTab, logoutProviders: async () => undefined,
      expose: async () => ({ kind: "exposed", url: "https://novnc.invalid/#p=pw", stop: stopExposure }),
      pollStatus: pollInstallStatus, finalize: finalizeCeremonyClaim,
      writeAgentConfigs: writeCeremonyAgentConfigs, detectProviders: async () => ["google"],
      log: () => undefined, pollIntervalMs: 100,
    });
    const confirmUrl = `${origin}/install?token=${code}&claim=1`;
    await host.call({
      action: "start", confirmUrl, setupCode: code, apiBase: apiOrigin,
      ttlMs: 120_000, callerHasDisplay: false,
      finalize: {
        baseSession: { api_base_url: apiOrigin, saved_at: new Date().toISOString(), machine_token: "tsm_finish_proof" },
        applyServerPrefs: true,
        agentConfigs: [{ target: "codex", profileDir, agentIdentity: "codex" }],
      },
    });
    const page = context.pages()[0]!;
    await waitFor(async () => (await (await openSessionStorage()).read(TEST_ACCOUNT)) !== null);
    expect(page.isClosed()).toBe(false);
    expect(stopExposure).not.toHaveBeenCalled();
    await expect(host.call({ action: "join", agentConfigs: [{ target: "hermes" }] })).resolves.toMatchObject({
      state: "live", confirm_url: confirmUrl, reused: true,
    });
    expect(context.pages()).toHaveLength(1);
    await page.route("**/v1/mcp/install/*/finish", (route) => route.fulfill({ status: 503, body: "unavailable" }));
    await page.getByRole("button", { name: "Finish", exact: true }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").textContent()).toContain("press Finish to retry");
    expect(page.url()).not.toContain("/install/done");
    expect(stopExposure).not.toHaveBeenCalled();
    await page.unroute("**/v1/mcp/install/*/finish");
    await page.getByRole("button", { name: "Finish", exact: true }).click();
    await waitFor(() => page.isClosed());
    expect(host.current()).toEqual({ state: "none" });
    expect(stopExposure).toHaveBeenCalledOnce();
    expect((await deps.pairingTokenStore.find(code)).finished_at).toBeInstanceOf(Date);
    expect(await (await openSessionStorage()).read(TEST_ACCOUNT)).toMatchObject({
      account_id: TEST_ACCOUNT, agent_session_token: expect.any(String), machine_token: "tsm_finish_proof",
    });
    const codex = parseToml(await readFile(join(home, ".codex", "config.toml"), "utf8")) as {
      mcp_servers?: { squire?: { env?: Record<string, string> } };
    };
    expect(codex.mcp_servers?.squire?.env).toMatchObject({
      TRUSTY_SQUIRE_ACCOUNT_ID: TEST_ACCOUNT, TRUSTY_SQUIRE_PROFILE_DIR: profileDir,
    });
  });
});
