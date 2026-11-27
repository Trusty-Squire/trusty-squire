import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import type { BrowserController, BrowserControllerOptions } from "../bot/browser.js";
import { BrowserProcessOwner } from "../bot/browser-process-owner.js";
import { PageDriver } from "../bot/page-driver.js";
import type { DriveHandoff } from "../bot/operate-drive.js";
import { CHROME_PROFILE_DIR, profilePathIdentity } from "../bot/profile-path.js";
import { openSessionStorage } from "../session.js";
import {
  assertIsolatedProfileDir,
  assertIsolatedSessionPath,
  clearSignupSession,
  connectSignupProfile,
  createSignupSession,
  DEFAULT_MAX_SIGNUP_HANDOFFS,
  ensureSignupSession,
  readSignupSession,
  redactSecrets,
  runSignup,
  SignupConfigError,
  SignupProfileIsolationError,
  SignupSessionIsolationError,
  writeSignupSession,
  type CapturedCredential,
  type EmbeddedBrowserLike,
  type SafeControlV2,
  type SignupHandoffEvent,
  type SignupRunRuntime,
  type SignupSession,
} from "../signup.js";

const SAMPLE_SESSION: SignupSession = {
  apiBaseUrl: "https://api.example.test",
  registryBaseUrl: "https://registry.example.test",
  accountId: "acc_01JEMBEDDEDTEST",
  agentSessionToken: "agt_secret_session_token_value",
  machineToken: "mch_secret_machine_token_value",
  savedAt: "2026-11-26T20:00:00.000Z",
  consentOperatorInboxOtp: true,
};

function makeHandoff(overrides: Partial<DriveHandoff> = {}): DriveHandoff {
  return {
    status: "complete",
    session_id: "sess-1",
    trajectory: [],
    done: "Signed up and generated an API key",
    remaining: "",
    steps: 4,
    seconds: 3.2,
    jev_calls: 2,
    message: "Completed",
    ...overrides,
  };
}

function makeFakeBrowser(): EmbeddedBrowserLike & {
  start: ReturnType<typeof vi.fn>;
  goto: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(async () => undefined),
    goto: vi.fn(async () => undefined),
    close: vi.fn(async () => "closed"),
    currentUrl: () => "https://app.example.test/keys",
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ts-embedded-signup-test-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("package subpath export metadata and runtime smoke test", () => {
  it("declares ./signup pointing to dist/signup.js and dist/signup.d.ts", () => {
    const pkgPath = resolve(import.meta.dirname, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      exports?: Record<string, { types?: string; import?: string }>;
      files?: string[];
    };
    expect(pkg.exports?.["./signup"]).toEqual({
      types: "./dist/signup.d.ts",
      import: "./dist/signup.js",
    });
    expect(pkg.files).toContain("dist");
  });

  it("compiles dist/signup.js + dist/signup.d.ts and resolves @trusty-squire/mcp/signup via Node exports", () => {
    const pkgRoot = resolve(import.meta.dirname, "../..");
    const distJs = join(pkgRoot, "dist", "signup.js");
    const distDts = join(pkgRoot, "dist", "signup.d.ts");
    const tscBin = join(
      pkgRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsc.cmd" : "tsc",
    );
    if (!existsSync(distJs) || !existsSync(distDts)) {
      execFileSync(tscBin, ["-p", "tsconfig.build.json"], { cwd: pkgRoot, stdio: "pipe" });
    }
    expect(existsSync(distJs)).toBe(true);
    expect(existsSync(distDts)).toBe(true);
    expect(existsSync(join(pkgRoot, "dist", "signup", "isolation.d.ts"))).toBe(true);
    expect(existsSync(join(pkgRoot, "dist", "signup", "session-store.d.ts"))).toBe(true);

    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import * as mod from "@trusty-squire/mcp/signup";
         const required = [
           "connectSignupProfile",
           "createSignupSession",
           "ensureSignupSession",
           "runSignup",
           "readSignupSession",
           "writeSignupSession",
           "clearSignupSession",
           "assertIsolatedProfileDir",
           "assertIsolatedSessionPath",
           "redactSecrets",
         ];
         for (const name of required) {
           if (typeof mod[name] !== "function") throw new Error("missing export: " + name);
         }
         process.stdout.write(JSON.stringify(required));`,
      ],
      { cwd: pkgRoot, encoding: "utf8" },
    );
    expect(JSON.parse(out)).toContain("runSignup");
  }, 30_000);
});

describe("profile and session isolation guards", () => {
  it("refuses to run without profileDir or cdpEndpoint (no silent default profile fallback)", async () => {
    await expect(
      runSignup({
        url: "https://app.example.test/signup",
        goal: "Sign up and create an API key",
        session: SAMPLE_SESSION,
        onCredentialCaptured: vi.fn(),
      }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof SignupConfigError && err.code === "browser_target_required",
    );

    await expect(
      connectSignupProfile({
        profileDir: "   ",
      }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof SignupConfigError && err.code === "browser_target_required",
    );
  });

  it("refuses Trusty Squire's default CHROME_PROFILE_DIR and symlinked aliases unless allowDefaultProfile is true", () => {
    expect(() => assertIsolatedProfileDir(CHROME_PROFILE_DIR)).toThrow(SignupProfileIsolationError);

    const envDefaultProfile = join(tempDir, "personal-squire-profile");
    vi.stubEnv("TRUSTY_SQUIRE_PROFILE_DIR", envDefaultProfile);
    expect(() => assertIsolatedProfileDir(envDefaultProfile)).toThrow(SignupProfileIsolationError);

    const symlinkAlias = join(tempDir, "profile-symlink");
    symlinkSync(envDefaultProfile, symlinkAlias);
    expect(() => assertIsolatedProfileDir(symlinkAlias)).toThrow(SignupProfileIsolationError);

    // Explicit opt-in succeeds
    expect(assertIsolatedProfileDir(envDefaultProfile, { allowDefaultProfile: true })).toBe(
      profilePathIdentity(envDefaultProfile),
    );
  });

  it("refuses Squire's personal session store directory unless allowDefaultSessionStore is true", () => {
    const xdgDir = join(tempDir, "xdg-config");
    vi.stubEnv("XDG_CONFIG_HOME", xdgDir);
    const defaultSessionFile = join(xdgDir, "trusty-squire", "session.json");
    const defaultPerAccountFile = join(xdgDir, "trusty-squire", "sessions", "acc_123.json");

    expect(() => assertIsolatedSessionPath(defaultSessionFile)).toThrow(
      SignupSessionIsolationError,
    );
    expect(() => assertIsolatedSessionPath(defaultPerAccountFile)).toThrow(
      SignupSessionIsolationError,
    );

    // App-owned sibling directory is allowed
    const appSessionPath = join(xdgDir, "grunt", "squire-session.json");
    expect(assertIsolatedSessionPath(appSessionPath)).toBe(profilePathIdentity(appSessionPath));
  });

  it("reads, writes (0600), and clears isolated session files without touching Squire's personal SessionStore", async () => {
    const xdgDir = join(tempDir, "xdg-config");
    vi.stubEnv("XDG_CONFIG_HOME", xdgDir);

    // Seed a personal Trusty Squire session first.
    const personalStore = await openSessionStorage();
    await personalStore.write({
      api_base_url: "https://personal.example.test",
      saved_at: "2026-11-26T00:00:00.000Z",
      account_id: "acc_personal_owner",
      agent_session_token: "personal_token_unchanged",
      machine_token: "personal_machine_unchanged",
    });

    const appSessionPath = join(tempDir, "grunt-data", "session.json");
    expect(await readSignupSession(appSessionPath)).toBeNull();

    await writeSignupSession(appSessionPath, SAMPLE_SESSION);
    const loaded = await readSignupSession(appSessionPath);
    expect(loaded).toEqual(SAMPLE_SESSION);

    if (process.platform !== "win32") {
      const mode = statSync(appSessionPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    // Personal Squire session store must remain completely untouched.
    const personalAfter = await personalStore.read("acc_personal_owner");
    expect(personalAfter?.agent_session_token).toBe("personal_token_unchanged");

    await clearSignupSession(appSessionPath);
    expect(await readSignupSession(appSessionPath)).toBeNull();
    expect((await personalStore.read("acc_personal_owner"))?.agent_session_token).toBe(
      "personal_token_unchanged",
    );
  });
});

describe("connectSignupProfile and ensureSignupSession", () => {
  it("runs Google sign-in ceremony against isolated profileDir and sessionPath without touching Squire's personal store or broker", async () => {
    const xdgDir = join(tempDir, "xdg-config");
    vi.stubEnv("XDG_CONFIG_HOME", xdgDir);
    const appProfileDir = join(tempDir, "grunt-chrome-profile");
    const appSessionPath = join(tempDir, "grunt-state", "signup-session.json");

    const browser = makeFakeBrowser();
    const createBrowser = vi.fn(() => browser);
    const onSignInOpen = vi.fn();
    const onSessionSaved = vi.fn();
    let polls = 0;

    const result = await connectSignupProfile(
      {
        profileDir: appProfileDir,
        sessionPath: appSessionPath,
        apiBaseUrl: "https://api.example.test",
        agentIdentity: "grunt",
        onSignInOpen,
        onSessionSaved,
        pollIntervalMs: 50,
      },
      {
        detectAsn: async () => null,
        issueMachineToken: async () => ({ machine_token: "mch_issued_1" }),
        installInitiate: async (apiBase, identity, machineToken) => {
          expect(apiBase).toBe("https://api.example.test");
          expect(identity).toBe("grunt");
          expect(machineToken).toBe("mch_issued_1");
          return {
            setup_code: "setup-code-1",
            confirm_url: "https://trustysquire.ai/confirm?code=setup-code-1",
            expires_at: "2026-11-26T21:00:00.000Z",
          };
        },
        createBrowser,
        drawsWindowsNatively: () => true,
        hasDisplay: () => true,
        pollInstallStatus: async () => {
          polls += 1;
          if (polls === 1) return { status: "pending" };
          if (polls === 2) {
            return {
              status: "claimed",
              account_id: "acc_grunt_user",
              agent_session_token: "agt_grunt_token",
              install_preferences: { consent_operator_inbox_otp: true },
              finished: false,
            };
          }
          return { status: "delivered", finished: true };
        },
        detectProviders: async (dir) => {
          expect(dir).toBe(profilePathIdentity(appProfileDir));
          return ["google"];
        },
        sleep: async () => undefined,
      },
    );

    expect(result.status).toBe("connected");
    if (result.status === "connected") {
      expect(result.session.accountId).toBe("acc_grunt_user");
      expect(result.session.agentSessionToken).toBe("agt_grunt_token");
      expect(result.session.machineToken).toBe("mch_issued_1");
      expect(result.providers).toEqual(["google"]);
      expect(result.browserLocation).toEqual({ kind: "host_screen" });
    }

    expect(createBrowser).toHaveBeenCalledWith({
      profileDir: profilePathIdentity(appProfileDir),
    });
    expect(browser.start).toHaveBeenCalledTimes(1);
    expect(browser.goto).toHaveBeenCalledWith(
      "https://trustysquire.ai/confirm?code=setup-code-1",
      undefined,
      "document-ready",
    );
    expect(onSignInOpen).toHaveBeenCalledWith({
      confirmUrl: "https://trustysquire.ai/confirm?code=setup-code-1",
      setupCode: "setup-code-1",
      browserLocation: { kind: "host_screen" },
    });
    expect(onSessionSaved).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalled();

    // Isolated session file persisted; personal Squire store still empty.
    expect((await readSignupSession(appSessionPath))?.agentSessionToken).toBe("agt_grunt_token");
    expect(await (await openSessionStorage()).read()).toBeNull();
  });

  it("exposes noVNC display on headless Linux and tears down exposure and browser in finally", async () => {
    const appProfileDir = join(tempDir, "headless-profile");
    const browser = makeFakeBrowser();
    const stopExposure = vi.fn(async () => undefined);
    const onSignInOpen = vi.fn();

    const result = await connectSignupProfile(
      {
        profileDir: appProfileDir,
        apiBaseUrl: "https://api.example.test",
        onSignInOpen,
        pollIntervalMs: 50,
      },
      {
        detectAsn: async () => null,
        issueMachineToken: async () => ({ machine_token: "mch_headless" }),
        installInitiate: async () => ({
          setup_code: "setup-headless",
          confirm_url: "https://trustysquire.ai/confirm?code=setup-headless",
          expires_at: "2026-11-26T21:00:00.000Z",
        }),
        createBrowser: () => browser,
        drawsWindowsNatively: () => false,
        hasDisplay: () => false,
        exposeDisplay: async () => ({
          kind: "exposed",
          url: "https://novnc.example.test/view",
          stop: stopExposure,
        }),
        pollInstallStatus: async () => ({
          status: "claimed",
          account_id: "acc_headless",
          agent_session_token: "agt_headless",
          finished: true,
        }),
        detectProviders: async () => ["google"],
        sleep: async () => undefined,
      },
    );

    expect(result.status).toBe("connected");
    expect(onSignInOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        browserLocation: { kind: "virtual", url: "https://novnc.example.test/view" },
      }),
    );
    expect(stopExposure).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalled();
  });

  it("returns already_connected in ensureSignupSession without launching a browser when session token and Google profile cookies are valid", async () => {
    const appProfileDir = join(tempDir, "cached-profile");
    const appSessionPath = join(tempDir, "cached-session.json");
    await writeSignupSession(appSessionPath, SAMPLE_SESSION);

    const createBrowser = vi.fn(() => makeFakeBrowser());
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    const result = await ensureSignupSession(
      {
        profileDir: appProfileDir,
        sessionPath: appSessionPath,
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        detectProviders: async () => ["google"],
        createBrowser,
      },
    );

    expect(result.status).toBe("already_connected");
    expect(createBrowser).not.toHaveBeenCalled();
  });

  it("triggers fresh ceremony in ensureSignupSession when stored token is rejected (401)", async () => {
    const appProfileDir = join(tempDir, "stale-profile");
    const appSessionPath = join(tempDir, "stale-session.json");
    await writeSignupSession(appSessionPath, SAMPLE_SESSION);

    const browser = makeFakeBrowser();
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));

    const result = await ensureSignupSession(
      {
        profileDir: appProfileDir,
        sessionPath: appSessionPath,
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        detectAsn: async () => null,
        issueMachineToken: async () => ({ machine_token: "mch_refreshed" }),
        installInitiate: async () => ({
          setup_code: "setup-refresh",
          confirm_url: "https://trustysquire.ai/confirm?code=setup-refresh",
          expires_at: "2026-11-26T21:00:00.000Z",
        }),
        createBrowser: () => browser,
        drawsWindowsNatively: () => true,
        hasDisplay: () => true,
        pollInstallStatus: async () => ({
          status: "claimed",
          account_id: "acc_refreshed",
          agent_session_token: "agt_refreshed",
          finished: true,
        }),
        detectProviders: async () => ["google"],
      },
    );

    expect(result.status).toBe("connected");
    expect(browser.start).toHaveBeenCalledTimes(1);
    expect((await readSignupSession(appSessionPath))?.agentSessionToken).toBe("agt_refreshed");
  });

  it("cancels ceremony cleanly on AbortSignal and closes browser", async () => {
    const appProfileDir = join(tempDir, "abort-profile");
    const browser = makeFakeBrowser();
    const controller = new AbortController();

    const result = await connectSignupProfile(
      {
        profileDir: appProfileDir,
        signal: controller.signal,
        pollIntervalMs: 50,
      },
      {
        detectAsn: async () => null,
        issueMachineToken: async () => ({ machine_token: "mch_abort" }),
        installInitiate: async () => ({
          setup_code: "setup-abort",
          confirm_url: "https://trustysquire.ai/confirm?code=setup-abort",
          expires_at: "2026-11-26T21:00:00.000Z",
        }),
        createBrowser: () => browser,
        drawsWindowsNatively: () => true,
        hasDisplay: () => true,
        pollInstallStatus: async () => {
          controller.abort();
          return { status: "pending" };
        },
      },
    );

    expect(result.status).toBe("cancelled");
    expect(browser.close).toHaveBeenCalled();
  });

  it("retries failed session saves on later polls without losing the one-time claimed token", async () => {
    const appProfileDir = join(tempDir, "retry-save-profile");
    const browser = makeFakeBrowser();
    let polls = 0;
    let saveCalls = 0;
    const onSessionSaved = vi.fn(async () => {
      saveCalls += 1;
      if (saveCalls === 1) throw new Error("transient sqlite busy");
    });

    const result = await connectSignupProfile(
      {
        profileDir: appProfileDir,
        apiBaseUrl: "https://api.example.test",
        onSessionSaved,
        pollIntervalMs: 50,
      },
      {
        detectAsn: async () => null,
        issueMachineToken: async () => ({ machine_token: "mch_retry_save" }),
        installInitiate: async () => ({
          setup_code: "setup-retry-save",
          confirm_url: "https://trustysquire.ai/confirm?code=setup-retry-save",
          expires_at: "2026-11-26T21:00:00.000Z",
        }),
        createBrowser: () => browser,
        drawsWindowsNatively: () => true,
        hasDisplay: () => true,
        pollInstallStatus: async () => {
          polls += 1;
          if (polls === 1) {
            return {
              status: "claimed",
              account_id: "acc_retry",
              agent_session_token: "agt_one_time_token_retry",
              finished: false,
            };
          }
          return { status: "delivered", finished: true };
        },
        detectProviders: async () => ["google"],
        sleep: async () => undefined,
      },
    );

    expect(result.status).toBe("connected");
    expect(onSessionSaved).toHaveBeenCalledTimes(2);
    if (result.status === "connected") {
      expect(result.session.agentSessionToken).toBe("agt_one_time_token_retry");
      expect(result.sessionSaveError).toBeUndefined();
    }
  });

  it("still returns the claimed session when persistence permanently fails (e.g. empty account_id or throwing callback) and redacts tokens from sessionSaveError", async () => {
    const appProfileDir = join(tempDir, "perm-fail-save-profile");
    const appSessionPath = join(tempDir, "perm-fail-session.json");
    const oneTimeToken = "agt_one_time_secret_do_not_lose";
    const browser = makeFakeBrowser();
    const onSessionSaved = vi.fn(async (s: SignupSession) => {
      throw new Error(`db refused ${s.agentSessionToken}`);
    });

    const result = await connectSignupProfile(
      {
        profileDir: appProfileDir,
        sessionPath: appSessionPath,
        apiBaseUrl: "https://api.example.test",
        onSessionSaved,
        pollIntervalMs: 50,
      },
      {
        detectAsn: async () => null,
        issueMachineToken: async () => ({ machine_token: "mch_perm_fail" }),
        installInitiate: async () => ({
          setup_code: "setup-perm-fail",
          confirm_url: "https://trustysquire.ai/confirm?code=setup-perm-fail",
          expires_at: "2026-11-26T21:00:00.000Z",
        }),
        createBrowser: () => browser,
        drawsWindowsNatively: () => true,
        hasDisplay: () => true,
        pollInstallStatus: async () => ({
          status: "claimed",
          account_id: "",
          agent_session_token: oneTimeToken,
          finished: true,
        }),
        detectProviders: async () => ["google"],
        sleep: async () => undefined,
      },
    );

    expect(result.status).toBe("connected");
    if (result.status === "connected") {
      expect(result.session.agentSessionToken).toBe(oneTimeToken);
      expect(result.sessionSaveError).toBeDefined();
      expect(result.sessionSaveError).toContain("[REDACTED]");
      expect(result.sessionSaveError).not.toContain(oneTimeToken);
    }
  });

  it("reports remote_cdp and skips local display exposure when both profileDir and cdpEndpoint are passed", async () => {
    const appProfileDir = join(tempDir, "both-profile");
    const cdpEndpoint = "http://127.0.0.1:9222";
    const browser = makeFakeBrowser();
    const exposeDisplay = vi.fn();
    const detectProviders = vi.fn(async () => ["google" as const]);
    const onSignInOpen = vi.fn();

    const result = await connectSignupProfile(
      {
        profileDir: appProfileDir,
        cdpEndpoint,
        apiBaseUrl: "https://api.example.test",
        onSignInOpen,
        pollIntervalMs: 50,
      },
      {
        detectAsn: async () => null,
        issueMachineToken: async () => ({ machine_token: "mch_both" }),
        installInitiate: async () => ({
          setup_code: "setup-both",
          confirm_url: "https://trustysquire.ai/confirm?code=setup-both",
          expires_at: "2026-11-26T21:00:00.000Z",
        }),
        createBrowser: () => browser,
        drawsWindowsNatively: () => false,
        hasDisplay: () => false,
        exposeDisplay,
        detectProviders,
        pollInstallStatus: async () => ({
          status: "claimed",
          account_id: "acc_both",
          agent_session_token: "agt_both",
          finished: true,
        }),
        sleep: async () => undefined,
      },
    );

    expect(result.status).toBe("connected");
    expect(exposeDisplay).not.toHaveBeenCalled();
    expect(detectProviders).not.toHaveBeenCalled();
    expect(onSignInOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        browserLocation: { kind: "remote_cdp", endpoint: cdpEndpoint },
      }),
    );
    if (result.status === "connected") {
      expect(result.browserLocation).toEqual({ kind: "remote_cdp", endpoint: cdpEndpoint });
    }
  });
});

describe("runSignup credential capture, vault prohibition, redaction, and teardown", () => {
  it("delivers extracted credentials strictly to onCredentialCaptured, never calls storeCredential, and redacts return payloads and logs", async () => {
    const appProfileDir = join(tempDir, "run-profile");
    const rawSecret = "sk_live_SUPER_SECRET_KEY_987654321";
    const captured: CapturedCredential[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const browser = makeFakeBrowser();
    const finishSession = vi.fn(async () => ({
      session_id: "sess-extract",
      operation_id: "op-1",
      execution: "completed" as const,
      mutation: "not_dispatched" as const,
      cleanup: "closed" as const,
      closed: true,
      url: "https://app.resend.com/api-keys",
    }));

    const storeCredentialSpy = vi.fn(async () => {
      throw new Error("should never be reached");
    });

    const result = await runSignup(
      {
        url: "https://resend.com/signup",
        goal: "Sign up with Google and create an API key",
        profileDir: appProfileDir,
        session: SAMPLE_SESSION,
        onCredentialCaptured: (cred) => {
          captured.push(cred);
        },
      },
      {
        createBrowser: () => browser as unknown as BrowserController,
        createApiClient: () =>
          ({
            setRequestingAgent: vi.fn(),
            storeCredential: storeCredentialSpy,
            decide: vi.fn(),
          }) as unknown as ApiClient,
        startHarnessSession: async (opts) => ({
          session_id: "sess-extract",
          url: opts.serviceUrl,
        }),
        finishSession,
        observedHostsForSession: () => ["resend.com", "api.resend.com"],
        currentProvisionUrl: () => "https://resend.com/api-keys",
        runDrive: async (_args, api, context, deps) => {
          // Verify belt-and-suspenders guard on ApiClient: storeCredential MUST reject!
          await expect(
            api!.storeCredential({ service: "resend", value: rawSecret }),
          ).rejects.toThrow(/forbids writing credentials/i);
          expect(storeCredentialSpy).not.toHaveBeenCalled();

          await deps!.startSession({ serviceUrl: "https://resend.com/signup" });
          const stored = await context!.persistCredentials!({
            session_id: "sess-extract",
            url: "https://resend.com/api-keys",
            credentials: { api_key: rawSecret },
          });
          expect(stored).toEqual({
            reference: "embedded:callback",
            service: "resend.com",
            label: undefined,
          });
          return makeHandoff({
            session_id: "sess-extract",
            // Intentionally echo secret into handoff message/done to prove redaction!
            done: `Created key ${rawSecret}`,
            message: `Key is ${rawSecret}`,
          });
        },
      },
    );

    expect(result.status).toBe("completed");
    expect(result.captured).toBe(true);
    expect(result.credentials).toEqual([
      {
        kind: "api_key",
        service: "resend.com",
        url: "https://resend.com/api-keys",
        captured: true,
        fieldNames: ["api_key"],
        source: "extract",
        observedHosts: ["resend.com", "api.resend.com", "*.resend.com"],
      },
    ]);

    // Callback received exact raw secret in-process.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.fields).toEqual({ api_key: rawSecret });

    // Return payload must contain ZERO occurrences of the raw secret.
    expect(JSON.stringify(result)).not.toContain(rawSecret);
    expect(result.done).toContain("[REDACTED]");
    expect(result.message).toContain("[REDACTED]");

    // Stderr/audit must contain ZERO occurrences of the raw secret.
    const allStderr = [
      ...stderrSpy.mock.calls.map((c) => String(c[0])),
      ...consoleErrorSpy.mock.calls.map((c) => c.map(String).join(" ")),
    ].join("\n");
    expect(allStderr).not.toContain(rawSecret);

    // Teardown ran cleanly.
    expect(finishSession).toHaveBeenCalledWith("sess-extract");
    expect(browser.close).toHaveBeenCalled();
  });

  it("supports explicit DOM and clipboard captureSource delivery without touching cloud vault", async () => {
    const appProfileDir = join(tempDir, "capture-profile");
    const domSecret = "pk_dom_secret_value_11111";
    const clipSecret = "sk_clip_secret_value_22222";
    const captured: CapturedCredential[] = [];
    const probeCaptureSource = vi.fn(async () => ({ candidate_count: 1, value: "old-clipboard" }));
    const captureCredentialSource = vi.fn(async (_sessionId, source, afterAction) => {
      if ("clipboard" in source) {
        expect(afterAction?.pre).toEqual({ candidate_count: 1, value: "old-clipboard" });
        return { candidate_count: 1, value: clipSecret, resolved_from: "post_action" as const };
      }
      return {
        candidate_count: 1,
        value: domSecret,
        resolved_source: { tag: "code", role: "code", name: "API Key" },
      };
    });

    const result = await runSignup(
      {
        url: "https://api.acme.dev/keys",
        goal: "Create an API key",
        service: "acme",
        profileDir: appProfileDir,
        session: SAMPLE_SESSION,
        captureSource: [{ role: "code", name: "API Key" }, { clipboard: true }],
        onCredentialCaptured: (cred) => {
          captured.push(cred);
        },
      },
      {
        createBrowser: () => makeFakeBrowser() as unknown as BrowserController,
        startHarnessSession: async (opts) => ({ session_id: "sess-cap", url: opts.serviceUrl }),
        finishSession: async () => ({
          session_id: "sess-cap",
          operation_id: "op-cap",
          execution: "completed",
          mutation: "not_dispatched",
          cleanup: "closed",
          closed: true,
          url: "https://api.acme.dev/keys",
        }),
        observedHostsForSession: () => ["api.acme.dev"],
        currentProvisionUrl: () => "https://api.acme.dev/keys",
        probeCaptureSource,
        captureCredentialSource,
        runDrive: async (_args, _api, _context, deps) => {
          await deps!.startSession({ serviceUrl: "https://api.acme.dev/keys" });
          return makeHandoff({ session_id: "sess-cap" });
        },
      },
    );

    expect(result.status).toBe("completed");
    expect(probeCaptureSource).toHaveBeenCalledWith("sess-cap", { clipboard: true });
    expect(captureCredentialSource).toHaveBeenCalledTimes(2);
    expect(captured.map((c) => c.fields.api_key)).toEqual([domSecret, clipSecret]);
    expect(JSON.stringify(result)).not.toContain(domSecret);
    expect(JSON.stringify(result)).not.toContain(clipSecret);
  });

  it("delivers invented password signups to callback instead of cloud vault", async () => {
    const appProfileDir = join(tempDir, "login-profile");
    const captured: CapturedCredential[] = [];
    const inventedPassword = "Strong!Password#998877";

    const result = await runSignup(
      {
        url: "https://service.example.test/register",
        goal: "Sign up with email and password",
        profileDir: appProfileDir,
        session: SAMPLE_SESSION,
        onCredentialCaptured: (cred) => {
          captured.push(cred);
        },
      },
      {
        createBrowser: () => makeFakeBrowser() as unknown as BrowserController,
        startHarnessSession: async (opts) => ({ session_id: "sess-login", url: opts.serviceUrl }),
        finishSession: async () => ({
          session_id: "sess-login",
          operation_id: "op-login",
          execution: "completed",
          mutation: "not_dispatched",
          cleanup: "closed",
          closed: true,
          url: "https://service.example.test/dashboard",
        }),
        observedHostsForSession: () => ["service.example.test"],
        currentProvisionUrl: () => "https://service.example.test/dashboard",
        extractCredentials: async () => ({
          session_id: "sess-login",
          url: "https://service.example.test/dashboard",
          credentials: {},
        }),
        runDrive: async (_args, _api, context, deps) => {
          await deps!.startSession({ serviceUrl: "https://service.example.test/register" });
          const saved = await context!.persistLogin!({
            sessionId: "sess-login",
            url: "https://service.example.test/register",
            login: "founder@example.test",
            password: inventedPassword,
          });
          expect(saved).toBe(true);
          return makeHandoff({ session_id: "sess-login" });
        },
      },
    );

    expect(result.status).toBe("completed");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.kind).toBe("login");
    expect(captured[0]?.source).toBe("invented_login");
    expect(captured[0]?.fields).toEqual({
      login: "founder@example.test",
      password: inventedPassword,
    });
    expect(JSON.stringify(result)).not.toContain(inventedPassword);
  });

  it("redacts secrets even when onCredentialCaptured throws an error echoing the secret", async () => {
    const appProfileDir = join(tempDir, "callback-err-profile");
    const leakedSecret = "sk_echoed_in_throw_445566";

    const result = await runSignup(
      {
        url: "https://app.example.test/keys",
        goal: "Create key",
        profileDir: appProfileDir,
        session: SAMPLE_SESSION,
        onCredentialCaptured: (cred) => {
          throw new Error(`Failed to persist ${cred.fields.api_key} to local db`);
        },
      },
      {
        createBrowser: () => makeFakeBrowser() as unknown as BrowserController,
        startHarnessSession: async (opts) => ({ session_id: "sess-err", url: opts.serviceUrl }),
        finishSession: async () => ({
          session_id: "sess-err",
          operation_id: "op-err",
          execution: "completed",
          mutation: "not_dispatched",
          cleanup: "closed",
          closed: true,
          url: "https://app.example.test/keys",
        }),
        observedHostsForSession: () => ["app.example.test"],
        currentProvisionUrl: () => "https://app.example.test/keys",
        extractCredentials: async () => ({
          session_id: "sess-err",
          url: "https://app.example.test/keys",
          credentials: { api_key: leakedSecret },
        }),
        runDrive: async (_args, _api, _context, deps) => {
          await deps!.startSession({ serviceUrl: "https://app.example.test/keys" });
          return makeHandoff({ session_id: "sess-err" });
        },
      },
    );

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(leakedSecret);
  });

  it("clears callbackFailure and returns completed when a retried onCredentialCaptured succeeds", async () => {
    const appProfileDir = join(tempDir, "callback-retry-profile");
    const secret = "sk_retried_secret_778899";
    const captured: CapturedCredential[] = [];
    let attempts = 0;

    const result = await runSignup(
      {
        url: "https://app.example.test/keys",
        goal: "Create key",
        profileDir: appProfileDir,
        session: SAMPLE_SESSION,
        onCredentialCaptured: (cred) => {
          attempts += 1;
          if (attempts === 1) throw new Error("transient write error");
          captured.push(cred);
        },
      },
      {
        createBrowser: () => makeFakeBrowser() as unknown as BrowserController,
        startHarnessSession: async (opts) => ({ session_id: "sess-retry", url: opts.serviceUrl }),
        finishSession: async () => ({
          session_id: "sess-retry",
          operation_id: "op-retry",
          execution: "completed",
          mutation: "not_dispatched",
          cleanup: "closed",
          closed: true,
          url: "https://app.example.test/keys",
        }),
        observedHostsForSession: () => ["app.example.test"],
        currentProvisionUrl: () => "https://app.example.test/keys",
        runDrive: async (_args, _api, context, deps) => {
          await deps!.startSession({ serviceUrl: "https://app.example.test/keys" });
          const first = await context!.persistCredentials!({
            session_id: "sess-retry",
            url: "https://app.example.test/keys",
            credentials: { api_key: secret },
          });
          expect(first).toBeNull();
          const second = await context!.persistCredentials!({
            session_id: "sess-retry",
            url: "https://app.example.test/keys",
            credentials: { api_key: secret },
          });
          expect(second).toEqual({
            reference: "embedded:callback",
            service: "example.test",
            label: undefined,
          });
          return makeHandoff({ session_id: "sess-retry" });
        },
      },
    );

    expect(attempts).toBe(2);
    expect(result.status).toBe("completed");
    expect(result.captured).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.fields.api_key).toBe(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("maps drive handoff statuses accurately (needs_human, low_confidence, needs_input, budget_exceeded)", async () => {
    const appProfileDir = join(tempDir, "handoff-profile");
    const cases: Array<{ handoff: Partial<DriveHandoff>; expected: string }> = [
      { handoff: { status: "awaiting_human", reason: "2FA required" }, expected: "needs_human" },
      {
        handoff: {
          status: "needs_value",
          needs_user: { wall: "google_session", message: "Reconnect Google", resume: "connect" },
        },
        expected: "needs_human",
      },
      {
        handoff: { status: "low_confidence", question: "Pick plan", options: { a: "Free" } },
        expected: "low_confidence",
      },
      { handoff: { status: "needs_value", field: "company_name" }, expected: "needs_input" },
      { handoff: { status: "budget", reason: "max_steps reached" }, expected: "budget_exceeded" },
    ];

    for (const tc of cases) {
      const result = await runSignup(
        {
          url: "https://app.example.test/signup",
          goal: "Sign up",
          profileDir: appProfileDir,
          session: SAMPLE_SESSION,
          onCredentialCaptured: vi.fn(),
        },
        {
          createBrowser: () => makeFakeBrowser() as unknown as BrowserController,
          startHarnessSession: async (opts) => ({ session_id: "sess-h", url: opts.serviceUrl }),
          finishSession: async () => ({
            session_id: "sess-h",
            operation_id: "op-h",
            execution: "completed",
            mutation: "not_dispatched",
            cleanup: "closed",
            closed: true,
            url: "https://app.example.test/signup",
          }),
          runDrive: async (_args, _api, _context, deps) => {
            await deps!.startSession({ serviceUrl: "https://app.example.test/signup" });
            return makeHandoff({ session_id: "sess-h", ...tc.handoff });
          },
        },
      );
      expect(result.status).toBe(tc.expected);
    }
  });

  it("always tears down session and browser in finally on error and on AbortSignal cancellation", async () => {
    const appProfileDir = join(tempDir, "teardown-profile");
    const browserErr = makeFakeBrowser();
    const finishSessionErr = vi.fn(async () => {
      throw new Error("finish timed out");
    });
    const forceFinishSessionErr = vi.fn(async () => true);

    const errResult = await runSignup(
      {
        url: "https://app.example.test/signup",
        goal: "Sign up",
        profileDir: appProfileDir,
        session: SAMPLE_SESSION,
        onCredentialCaptured: vi.fn(),
      },
      {
        createBrowser: () => browserErr as unknown as BrowserController,
        startHarnessSession: async (opts) => ({ session_id: "sess-fail", url: opts.serviceUrl }),
        finishSession: finishSessionErr,
        forceFinishSession: forceFinishSessionErr,
        runDrive: async (_args, _api, _context, deps) => {
          await deps!.startSession({ serviceUrl: "https://app.example.test/signup" });
          throw new Error("unexpected network crash");
        },
      },
    );

    expect(errResult.status).toBe("failed");
    expect(finishSessionErr).toHaveBeenCalledWith("sess-fail");
    expect(forceFinishSessionErr).toHaveBeenCalledWith("sess-fail");
    expect(browserErr.close).toHaveBeenCalledWith({ cancelStart: true });

    // AbortSignal cancellation
    const controller = new AbortController();
    const browserAbort = makeFakeBrowser();
    const cancelResult = await runSignup(
      {
        url: "https://app.example.test/signup",
        goal: "Sign up",
        profileDir: appProfileDir,
        session: SAMPLE_SESSION,
        signal: controller.signal,
        onCredentialCaptured: vi.fn(),
      },
      {
        createBrowser: () => browserAbort as unknown as BrowserController,
        startHarnessSession: async (opts) => ({ session_id: "sess-abort", url: opts.serviceUrl }),
        finishSession: async () => ({
          session_id: "sess-abort",
          operation_id: "op-abort",
          execution: "completed",
          mutation: "not_dispatched",
          cleanup: "closed",
          closed: true,
          url: "https://app.example.test/signup",
        }),
        runDrive: async (_args, _api, context, deps) => {
          await deps!.startSession({ serviceUrl: "https://app.example.test/signup" });
          controller.abort(new Error("user cancelled"));
          if (context?.signal?.aborted) throw context.signal.reason;
          return makeHandoff({ session_id: "sess-abort" });
        },
      },
    );

    expect(cancelResult.status).toBe("cancelled");
    expect(browserAbort.close).toHaveBeenCalledWith({ cancelStart: true });
  });

  it("threads cdpEndpoint per call without mutating global process.env.BOT_CDP_ENDPOINT", async () => {
    vi.stubEnv("BOT_CDP_ENDPOINT", "http://127.0.0.1:9999");
    const observedOptions: BrowserControllerOptions[] = [];

    await Promise.all([
      runSignup(
        {
          url: "https://a.example.test/signup",
          goal: "Sign up A",
          cdpEndpoint: "http://127.0.0.1:9222",
          session: SAMPLE_SESSION,
          onCredentialCaptured: vi.fn(),
        },
        {
          createBrowser: (opts) => {
            observedOptions.push(opts);
            return makeFakeBrowser() as unknown as BrowserController;
          },
          startHarnessSession: async (opts) => ({ session_id: "sess-a", url: opts.serviceUrl }),
          finishSession: async () => ({
            session_id: "sess-a",
            operation_id: "op-a",
            execution: "completed",
            mutation: "not_dispatched",
            cleanup: "closed",
            closed: true,
            url: "https://a.example.test/signup",
          }),
          runDrive: async (_args, _api, _ctx, deps) => {
            await deps!.startSession({ serviceUrl: "https://a.example.test/signup" });
            return makeHandoff({ session_id: "sess-a" });
          },
        },
      ),
      runSignup(
        {
          url: "https://b.example.test/signup",
          goal: "Sign up B",
          cdpEndpoint: "http://127.0.0.1:9333",
          session: SAMPLE_SESSION,
          onCredentialCaptured: vi.fn(),
        },
        {
          createBrowser: (opts) => {
            observedOptions.push(opts);
            return makeFakeBrowser() as unknown as BrowserController;
          },
          startHarnessSession: async (opts) => ({ session_id: "sess-b", url: opts.serviceUrl }),
          finishSession: async () => ({
            session_id: "sess-b",
            operation_id: "op-b",
            execution: "completed",
            mutation: "not_dispatched",
            cleanup: "closed",
            closed: true,
            url: "https://b.example.test/signup",
          }),
          runDrive: async (_args, _api, _ctx, deps) => {
            await deps!.startSession({ serviceUrl: "https://b.example.test/signup" });
            return makeHandoff({ session_id: "sess-b" });
          },
        },
      ),
    ]);

    expect(process.env.BOT_CDP_ENDPOINT).toBe("http://127.0.0.1:9999");
    expect(observedOptions.map((o) => o.cdpEndpoint).sort()).toEqual([
      "http://127.0.0.1:9222",
      "http://127.0.0.1:9333",
    ]);
    expect(observedOptions.every((o) => o.profileDir === undefined)).toBe(true);
  });

  it("allows BrowserProcessOwner with explicit cdpEndpoint to close cleanly without profileDir", async () => {
    const pages = new PageDriver(() => null, false);
    const owner = new BrowserProcessOwner(
      { cdpEndpoint: "http://127.0.0.1:9222" },
      pages,
      async () => undefined,
    );
    expect(await owner.close()).toBe("closed");
  });
});

describe("redactSecrets", () => {
  it("redacts multiple secrets longest-first without leaving partial tails", () => {
    const out = redactSecrets("token=sk_live_abc123456 and prefix=sk_live_abc", [
      "sk_live_abc",
      "sk_live_abc123456",
    ]);
    expect(out).toBe("token=[REDACTED] and prefix=[REDACTED]");
  });
});

describe("runSignup onHandoff pause-and-resume on same live browser session", () => {
  it("keeps browser and session open on needs_value, resumes on same session_id with answer, captures credential, and tears down once in finally", async () => {
    const appProfileDir = join(tempDir, "handoff-needs-value-profile");
    const rawSecret = "sk_live_HANDOFF_RESUMED_KEY_12345";
    const captured: CapturedCredential[] = [];
    const seenEvents: SignupHandoffEvent[] = [];
    const driveCalls: Array<Record<string, unknown>> = [];

    const browser = makeFakeBrowser();
    const finishSession = vi.fn(async () => ({
      session_id: "sess-live-dialog",
      operation_id: "op-1",
      execution: "completed" as const,
      mutation: "not_dispatched" as const,
      cleanup: "closed" as const,
      closed: true,
      url: "https://app.example.test/api-keys",
    }));

    const result = await runSignup(
      {
        url: "https://app.example.test/api-keys",
        goal: "Create an API key",
        profileDir: appProfileDir,
        session: SAMPLE_SESSION,
        facts: { email: "dev@example.test" },
        onCredentialCaptured: (cred) => {
          captured.push(cred);
        },
        onHandoff: async (event) => {
          seenEvents.push(event);
          // Session and browser must STILL be open while handling the pause!
          expect(finishSession).not.toHaveBeenCalled();
          expect(browser.close).not.toHaveBeenCalled();
          return { answer: "Grunt Production Key" };
        },
      },
      {
        createBrowser: () => browser as unknown as BrowserController,
        startHarnessSession: async (opts) => ({
          session_id: "sess-live-dialog",
          url: opts.serviceUrl,
        }),
        finishSession,
        observedHostsForSession: () => ["app.example.test"],
        currentProvisionUrl: () => "https://app.example.test/api-keys?modal=new-key",
        extractCredentials: async (sid) => {
          expect(sid).toBe("sess-live-dialog");
          expect(finishSession).not.toHaveBeenCalled();
          expect(browser.close).not.toHaveBeenCalled();
          return {
            session_id: sid,
            url: "https://app.example.test/api-keys",
            credentials: { api_key: rawSecret },
          };
        },
        runDrive: async (args, _api, _context, deps) => {
          driveCalls.push({ ...args });
          expect(finishSession).not.toHaveBeenCalled();
          expect(browser.close).not.toHaveBeenCalled();
          if (driveCalls.length === 1) {
            await deps!.startSession({ serviceUrl: args.url! });
            return makeHandoff({
              status: "needs_value",
              session_id: "sess-live-dialog",
              field: "api_key_name",
              question: "Enter a name for the new API key",
              remaining: "Submit API key creation dialog",
              message: "Need key name",
              steps: 3,
              seconds: 2.5,
              jev_calls: 2,
            });
          }
          return makeHandoff({
            status: "complete",
            session_id: "sess-live-dialog",
            done: "Created API key",
            remaining: "",
            steps: 2,
            seconds: 1.5,
            jev_calls: 3,
          });
        },
      },
    );

    expect(driveCalls).toHaveLength(2);
    expect(driveCalls[0]).toMatchObject({
      url: "https://app.example.test/api-keys",
      goal: "Create an API key",
      facts: { email: "dev@example.test" },
    });
    expect(driveCalls[0]?.session_id).toBeUndefined();
    expect(driveCalls[1]).toMatchObject({
      session_id: "sess-live-dialog",
      goal: "Create an API key",
      answer: "Grunt Production Key",
      facts: { email: "dev@example.test" },
    });
    expect(driveCalls[1]?.url).toBeUndefined();

    expect(seenEvents).toEqual([
      {
        status: "needs_input",
        driveStatus: "needs_value",
        url: "https://app.example.test/api-keys?modal=new-key",
        attempt: 1,
        field: "api_key_name",
        question: "Enter a name for the new API key",
        remaining: "Submit API key creation dialog",
        message: "Need key name",
      },
    ]);

    expect(result.status).toBe("completed");
    expect(result.captured).toBe(true);
    expect(result.steps).toBe(5);
    expect(result.seconds).toBe(4);
    expect(result.jevCalls).toBe(3);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.fields).toEqual({ api_key: rawSecret });
    expect(JSON.stringify(result)).not.toContain(rawSecret);

    // Torn down exactly once in finally after credential capture completed.
    expect(finishSession).toHaveBeenCalledTimes(1);
    expect(finishSession).toHaveBeenCalledWith("sess-live-dialog");
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledWith({ cancelStart: true });
  });

  it("resumes on same session_id for low_confidence / OAuth choice and merges facts across multiple pauses without mutating caller facts", async () => {
    const appProfileDir = join(tempDir, "handoff-oauth-profile");
    const rawSecret = "sk_live_OAUTH_RESUMED_KEY_67890";
    const captured: CapturedCredential[] = [];
    const seenEvents: SignupHandoffEvent[] = [];
    const driveCalls: Array<Record<string, unknown>> = [];
    const initialFacts = { email: "dev@example.test", team: "Initial" };

    const browser = makeFakeBrowser();
    const finishSession = vi.fn(async () => ({
      session_id: "sess-oauth",
      operation_id: "op-oauth",
      execution: "completed" as const,
      mutation: "not_dispatched" as const,
      cleanup: "closed" as const,
      closed: true,
      url: "https://app.example.test/keys",
    }));

    const result = await runSignup(
      {
        url: "https://app.example.test/login",
        goal: "Sign up and create an API key",
        profileDir: appProfileDir,
        session: SAMPLE_SESSION,
        facts: initialFacts,
        onCredentialCaptured: (cred) => {
          captured.push(cred);
        },
        onHandoff: (event) => {
          seenEvents.push(event);
          expect(finishSession).not.toHaveBeenCalled();
          expect(browser.close).not.toHaveBeenCalled();
          if (event.attempt === 1) {
            return { answer: "a", facts: { team: "UpdatedTeam" } };
          }
          return { resume: true, facts: { workspace: "prod" } };
        },
      },
      {
        createBrowser: () => browser as unknown as BrowserController,
        startHarnessSession: async (opts) => ({ session_id: "sess-oauth", url: opts.serviceUrl }),
        finishSession,
        observedHostsForSession: () => ["app.example.test"],
        currentProvisionUrl: () => "https://app.example.test/oauth/choose",
        runDrive: async (args, _api, context, deps) => {
          driveCalls.push({ ...args });
          if (driveCalls.length === 1) {
            await deps!.startSession({ serviceUrl: args.url! });
            return makeHandoff({
              status: "low_confidence",
              session_id: "sess-oauth",
              question: "Choose OAuth sign-in provider",
              options: { a: "Continue with Google", b: "Continue with GitHub" },
              probabilities: { a: 0.51, b: 0.49 },
              oauth: {
                state: "awaiting_human",
                reason: "Multiple OAuth providers available",
                next_action: "operate_observe",
              },
              remaining: "Pick sign-in provider",
              steps: 2,
              seconds: 1,
              jev_calls: 1,
            });
          }
          if (driveCalls.length === 2) {
            return makeHandoff({
              status: "awaiting_human",
              session_id: "sess-oauth",
              oauth: {
                state: "awaiting_human",
                reason: "Approve 2FA prompt on device",
                next_action: "operate_observe",
              },
              reason: "Approve 2FA prompt on device",
              remaining: "Finish 2FA verification",
              steps: 1,
              seconds: 1,
              jev_calls: 2,
            });
          }
          await context!.persistCredentials!({
            session_id: "sess-oauth",
            url: "https://app.example.test/keys",
            credentials: { api_key: rawSecret },
          });
          return makeHandoff({
            status: "complete",
            session_id: "sess-oauth",
            steps: 2,
            seconds: 1,
            jev_calls: 3,
          });
        },
      },
    );

    expect(driveCalls).toHaveLength(3);
    expect(driveCalls[1]).toMatchObject({
      session_id: "sess-oauth",
      answer: "a",
      facts: { email: "dev@example.test", team: "UpdatedTeam" },
    });
    expect(driveCalls[2]).toMatchObject({
      session_id: "sess-oauth",
      facts: { email: "dev@example.test", team: "UpdatedTeam", workspace: "prod" },
    });
    // Stale answer from attempt 1 must NOT leak into attempt 2 resume.
    expect(driveCalls[2]?.answer).toBeUndefined();
    // Caller's original facts object must not be mutated.
    expect(initialFacts).toEqual({ email: "dev@example.test", team: "Initial" });

    expect(seenEvents).toHaveLength(2);
    expect(seenEvents[0]).toMatchObject({
      status: "low_confidence",
      driveStatus: "low_confidence",
      attempt: 1,
      question: "Choose OAuth sign-in provider",
      options: { a: "Continue with Google", b: "Continue with GitHub" },
      probabilities: { a: 0.51, b: 0.49 },
      oauth: {
        state: "awaiting_human",
        reason: "Multiple OAuth providers available",
        next_action: "operate_observe",
      },
    });
    expect(seenEvents[1]).toMatchObject({
      status: "needs_human",
      driveStatus: "awaiting_human",
      attempt: 2,
      reason: "Approve 2FA prompt on device",
    });

    expect(result.status).toBe("completed");
    expect(result.captured).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.fields).toEqual({ api_key: rawSecret });
    expect(finishSession).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("returns pause result and tears down browser when onHandoff returns null, undefined, empty object, or resume:false", async () => {
    const appProfileDir = join(tempDir, "handoff-decline-profile");
    const responses = [null, undefined, {}, { resume: false, answer: "ignored" }];

    for (const response of responses) {
      const browser = makeFakeBrowser();
      const finishSession = vi.fn(async () => ({
        session_id: "sess-decline",
        operation_id: "op-decline",
        execution: "completed" as const,
        mutation: "not_dispatched" as const,
        cleanup: "closed" as const,
        closed: true,
        url: "https://app.example.test/keys",
      }));
      const runDrive = vi.fn(async (_args, _api, _context, deps) => {
        await deps!.startSession({ serviceUrl: "https://app.example.test/keys" });
        return makeHandoff({
          status: "needs_value",
          session_id: "sess-decline",
          field: "api_key_name",
          question: "Key name?",
        });
      });

      const result = await runSignup(
        {
          url: "https://app.example.test/keys",
          goal: "Create key",
          profileDir: appProfileDir,
          session: SAMPLE_SESSION,
          onCredentialCaptured: vi.fn(),
          onHandoff: () => response,
        },
        {
          createBrowser: () => browser as unknown as BrowserController,
          startHarnessSession: async (opts) => ({
            session_id: "sess-decline",
            url: opts.serviceUrl,
          }),
          finishSession,
          runDrive,
        },
      );

      expect(runDrive).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("needs_input");
      expect(result.driveStatus).toBe("needs_value");
      expect(result.field).toBe("api_key_name");
      expect(result.question).toBe("Key name?");
      expect(finishSession).toHaveBeenCalledTimes(1);
      expect(browser.close).toHaveBeenCalledTimes(1);
    }
  });

  it("fails cleanly, redacts already-captured secrets in event and thrown error, and tears down browser when onHandoff throws", async () => {
    const appProfileDir = join(tempDir, "handoff-throw-profile");
    const priorPassword = "Prior!Invented#Password99";
    const captured: CapturedCredential[] = [];
    let observedEvent: SignupHandoffEvent | undefined;
    const browser = makeFakeBrowser();
    const finishSession = vi.fn(async () => ({
      session_id: "sess-throw",
      operation_id: "op-throw",
      execution: "completed" as const,
      mutation: "not_dispatched" as const,
      cleanup: "closed" as const,
      closed: true,
      url: "https://app.example.test/keys",
    }));

    const result = await runSignup(
      {
        url: "https://app.example.test/signup",
        goal: "Sign up and create key",
        profileDir: appProfileDir,
        session: SAMPLE_SESSION,
        onCredentialCaptured: (cred) => {
          captured.push(cred);
        },
        onHandoff: async (event) => {
          observedEvent = event;
          throw new Error(`UI prompt crashed with ${priorPassword}`);
        },
      },
      {
        createBrowser: () => browser as unknown as BrowserController,
        startHarnessSession: async (opts) => ({ session_id: "sess-throw", url: opts.serviceUrl }),
        finishSession,
        runDrive: async (_args, _api, context, deps) => {
          await deps!.startSession({ serviceUrl: "https://app.example.test/signup" });
          await context!.persistLogin!({
            sessionId: "sess-throw",
            url: "https://app.example.test/signup",
            login: "user@example.test",
            password: priorPassword,
          });
          return makeHandoff({
            status: "needs_value",
            session_id: "sess-throw",
            field: "api_key_name",
            message: `Context echoed ${priorPassword}`,
            steps: 2,
          });
        },
      },
    );

    expect(observedEvent?.message).toContain("[REDACTED]");
    expect(observedEvent?.message).not.toContain(priorPassword);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("onHandoff callback failed");
    expect(result.reason).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(priorPassword);
    expect(result.steps).toBe(2);
    expect(captured).toHaveLength(1);
    expect(finishSession).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("aborts cleanly and tears down browser if AbortSignal fires while awaiting onHandoff", async () => {
    const appProfileDir = join(tempDir, "handoff-abort-profile");
    const controller = new AbortController();
    const browser = makeFakeBrowser();
    const finishSession = vi.fn(async () => ({
      session_id: "sess-abort-handoff",
      operation_id: "op-abort",
      execution: "completed" as const,
      mutation: "not_dispatched" as const,
      cleanup: "closed" as const,
      closed: true,
      url: "https://app.example.test/keys",
    }));

    const resultPromise = runSignup(
      {
        url: "https://app.example.test/keys",
        goal: "Create key",
        profileDir: appProfileDir,
        session: SAMPLE_SESSION,
        signal: controller.signal,
        onCredentialCaptured: vi.fn(),
        onHandoff: () =>
          new Promise(() => {
            // Simulate caller waiting indefinitely on user input until aborted.
            queueMicrotask(() => controller.abort(new Error("user cancelled modal")));
          }),
      },
      {
        createBrowser: () => browser as unknown as BrowserController,
        startHarnessSession: async (opts) => ({
          session_id: "sess-abort-handoff",
          url: opts.serviceUrl,
        }),
        finishSession,
        runDrive: async (_args, _api, _context, deps) => {
          await deps!.startSession({ serviceUrl: "https://app.example.test/keys" });
          return makeHandoff({
            status: "needs_value",
            session_id: "sess-abort-handoff",
            field: "api_key_name",
          });
        },
      },
    );

    const result = await resultPromise;
    expect(result.status).toBe("cancelled");
    expect(result.reason).toContain("user cancelled modal");
    expect(finishSession).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalled();
  });

  it("enforces handoff-resume loop cap, maxSteps, and maxSeconds budgets across resumes", async () => {
    const appProfileDir = join(tempDir, "handoff-budget-profile");

    // 1. Default maxHandoffs loop cap prevents infinite resume loops.
    const browserCap = makeFakeBrowser();
    const finishCap = vi.fn(async () => ({
      session_id: "sess-cap",
      operation_id: "op-cap",
      execution: "completed" as const,
      mutation: "not_dispatched" as const,
      cleanup: "closed" as const,
      closed: true,
      url: "https://app.example.test/keys",
    }));
    const onHandoffCap = vi.fn(() => ({ answer: "same-answer" }));
    const runDriveCap = vi.fn(async (args, _api, _context, deps) => {
      if (args.session_id === undefined) {
        await deps!.startSession({ serviceUrl: args.url! });
      }
      return makeHandoff({
        status: "needs_value",
        session_id: "sess-cap",
        field: "api_key_name",
        steps: 1,
        seconds: 0.1,
      });
    });

    const capResult = await runSignup(
      {
        url: "https://app.example.test/keys",
        goal: "Create key",
        profileDir: appProfileDir,
        session: SAMPLE_SESSION,
        onCredentialCaptured: vi.fn(),
        onHandoff: onHandoffCap,
      },
      {
        createBrowser: () => browserCap as unknown as BrowserController,
        startHarnessSession: async (opts) => ({ session_id: "sess-cap", url: opts.serviceUrl }),
        finishSession: finishCap,
        runDrive: runDriveCap,
      },
    );

    expect(capResult.status).toBe("budget_exceeded");
    expect(capResult.reason).toMatch(/handoff resume limit/i);
    expect(onHandoffCap).toHaveBeenCalledTimes(DEFAULT_MAX_SIGNUP_HANDOFFS);
    expect(runDriveCap).toHaveBeenCalledTimes(DEFAULT_MAX_SIGNUP_HANDOFFS + 1);
    expect(finishCap).toHaveBeenCalledTimes(1);
    expect(browserCap.close).toHaveBeenCalledTimes(1);

    // 2. maxSteps is decremented across resumed calls and stops cleanly when exhausted.
    const stepArgs: Array<number | undefined> = [];
    const runDriveSteps = vi.fn(async (args, _api, _context, deps) => {
      stepArgs.push(args.max_steps);
      if (args.session_id === undefined) {
        await deps!.startSession({ serviceUrl: args.url! });
      }
      return makeHandoff({
        status: "needs_value",
        session_id: "sess-steps",
        field: "api_key_name",
        steps: 3,
        seconds: 0.5,
      });
    });

    const stepResult = await runSignup(
      {
        url: "https://app.example.test/keys",
        goal: "Create key",
        profileDir: appProfileDir,
        session: SAMPLE_SESSION,
        maxSteps: 5,
        onCredentialCaptured: vi.fn(),
        onHandoff: () => ({ answer: "my-key" }),
      },
      {
        createBrowser: () => makeFakeBrowser() as unknown as BrowserController,
        startHarnessSession: async (opts) => ({ session_id: "sess-steps", url: opts.serviceUrl }),
        finishSession: async () => ({
          session_id: "sess-steps",
          operation_id: "op-steps",
          execution: "completed" as const,
          mutation: "not_dispatched" as const,
          cleanup: "closed" as const,
          closed: true,
          url: "https://app.example.test/keys",
        }),
        runDrive: runDriveSteps,
      },
    );

    expect(stepArgs).toEqual([5, 2]);
    expect(stepResult.status).toBe("budget_exceeded");
    expect(stepResult.reason).toMatch(/maxSteps/i);

    // 3. maxSeconds is decremented across resumed calls and stops cleanly when exhausted.
    let fakeNow = 10_000;
    const secondArgs: Array<number | undefined> = [];
    const runDriveSeconds = vi.fn(async (args, _api, _context, deps) => {
      secondArgs.push(args.max_seconds);
      if (args.session_id === undefined) {
        await deps!.startSession({ serviceUrl: args.url! });
      }
      fakeNow += 4_000;
      return makeHandoff({
        status: "needs_value",
        session_id: "sess-secs",
        field: "api_key_name",
        steps: 1,
        seconds: 4,
      });
    });

    const secResult = await runSignup(
      {
        url: "https://app.example.test/keys",
        goal: "Create key",
        profileDir: appProfileDir,
        session: SAMPLE_SESSION,
        maxSeconds: 10,
        onCredentialCaptured: vi.fn(),
        onHandoff: () => {
          fakeNow += 2_000;
          return { answer: "my-key" };
        },
      },
      {
        createBrowser: () => makeFakeBrowser() as unknown as BrowserController,
        startHarnessSession: async (opts) => ({ session_id: "sess-secs", url: opts.serviceUrl }),
        finishSession: async () => ({
          session_id: "sess-secs",
          operation_id: "op-secs",
          execution: "completed" as const,
          mutation: "not_dispatched" as const,
          cleanup: "closed" as const,
          closed: true,
          url: "https://app.example.test/keys",
        }),
        runDrive: runDriveSeconds,
        now: () => fakeNow,
      },
    );

    expect(secondArgs).toEqual([10, 4]);
    expect(secResult.status).toBe("budget_exceeded");
    expect(secResult.reason).toMatch(/maxSeconds/i);
  });
});

describe("createSignupSession stateful pause/resume handle", () => {
  it("keeps browser and provision session alive across non-terminal pauses, resumes with same session_id, redacts observation, and closes idempotently once", async () => {
    const appProfileDir = join(tempDir, "stateful-resume-profile");
    const rawSecret = "sk_live_STATEFUL_SESSION_KEY_555666";
    const captured: CapturedCredential[] = [];
    const progressEvents: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const driveCalls: Array<Record<string, unknown>> = [];
    const initialFacts = { email: "dev@example.test" };
    const turn2Facts = { project: "grunt" };

    const browser = makeFakeBrowser();
    const createBrowser = vi.fn(() => browser as unknown as BrowserController);
    const startHarnessSession = vi.fn(async (opts: { serviceUrl: string }) => ({
      session_id: "sess-stateful-1",
      url: opts.serviceUrl,
    }));
    const finishSession = vi.fn(async () => ({
      session_id: "sess-stateful-1",
      operation_id: "op-stateful",
      execution: "completed" as const,
      mutation: "not_dispatched" as const,
      cleanup: "closed" as const,
      closed: true,
      url: "https://app.example.test/api-keys",
    }));
    const forceFinishSession = vi.fn(async () => true);

    const session = await createSignupSession(
      {
        url: "https://app.example.test/api-keys",
        profileDir: appProfileDir,
        session: SAMPLE_SESSION,
        facts: initialFacts,
        onCredentialCaptured: (cred) => {
          captured.push(cred);
        },
        onProgress: (message, data) => {
          progressEvents.push({ message, ...(data !== undefined ? { data } : {}) });
        },
      },
      {
        createBrowser,
        startHarnessSession,
        finishSession,
        forceFinishSession,
        observedHostsForSession: () => ["app.example.test"],
        currentProvisionUrl: () => "https://app.example.test/api-keys?modal=open",
        runDrive: async (args, _api, context, deps) => {
          driveCalls.push({ ...args });
          if (driveCalls.length === 1) {
            await deps!.startSession({ serviceUrl: args.url! });
            return makeHandoff({
              status: "needs_value",
              session_id: "sess-stateful-1",
              field: "api_key_name",
              question: "Name your API key",
              observation: {
                session_id: "sess-stateful-1",
                url: "https://app.example.test/api-keys?modal=open",
                safe_table: [["@key-name", "t", "Key name|s=r"]] as unknown as SafeControlV2[],
                dom: "raw DOM text that must be stripped from SignupObservationSummary",
              },
              steps: 2,
              seconds: 1.2,
              jev_calls: 1,
            });
          }
          if (driveCalls.length === 2) {
            return makeHandoff({
              status: "low_confidence",
              session_id: "sess-stateful-1",
              question: "Pick key scope",
              options: { full: "Full access", read: "Read only" },
              probabilities: { full: 0.52, read: 0.48 },
              observation: {
                session_id: "sess-stateful-1",
                url: "https://app.example.test/api-keys?modal=open",
                safe_table: [
                  ["@scope-full", "r", "Full access"],
                  ["@scope-read", "r", "Read only"],
                ] as unknown as SafeControlV2[],
              },
              steps: 1,
              seconds: 0.8,
              jev_calls: 2,
            });
          }
          await context!.persistCredentials!({
            session_id: "sess-stateful-1",
            url: "https://app.example.test/api-keys",
            credentials: { api_key: rawSecret },
          });
          await context!.notifyUser!(`Captured ${rawSecret}`, { leaked: rawSecret });
          return makeHandoff({
            status: "complete",
            session_id: "sess-stateful-1",
            done: `Created ${rawSecret}`,
            observation: {
              session_id: "sess-stateful-1",
              url: "https://app.example.test/api-keys",
              safe_table: [["@copy", "b", `Copy ${rawSecret}`]] as unknown as SafeControlV2[],
              dom: `Secret dom ${rawSecret}`,
            },
            steps: 2,
            seconds: 1.5,
            jev_calls: 3,
          });
        },
      },
    );

    expect(createBrowser).toHaveBeenCalledTimes(1);
    expect(session.sessionId).toBeNull();
    expect(session.closed).toBe(false);

    // Turn 1: pauses with needs_value -> browser & provision session stay open!
    const turn1 = await session.drive({ goal: "Create an API key" });
    expect(turn1.status).toBe("needs_input");
    expect(turn1.driveStatus).toBe("needs_value");
    expect(turn1.field).toBe("api_key_name");
    expect(turn1.observation).toEqual({
      url: "https://app.example.test/api-keys?modal=open",
      safe_table: [["@key-name", "t", "Key name|s=r"]],
    });
    expect("dom" in (turn1.observation ?? {})).toBe(false);
    expect(session.sessionId).toBe("sess-stateful-1");
    expect(finishSession).not.toHaveBeenCalled();
    expect(forceFinishSession).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();

    // Turn 2: resumes on exact same session_id with answer + facts -> pauses with low_confidence.
    const turn2 = await session.drive({
      goal: "Create an API key",
      answer: "Grunt Key",
      facts: turn2Facts,
    });
    expect(turn2.status).toBe("low_confidence");
    expect(turn2.options).toEqual({ full: "Full access", read: "Read only" });
    expect(finishSession).not.toHaveBeenCalled();
    expect(forceFinishSession).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();

    // Turn 3: answers low_confidence choice on exact same session_id -> completes & redacts!
    const turn3 = await session.drive({
      goal: "Create an API key",
      answer: "full",
    });
    expect(turn3.status).toBe("completed");
    expect(turn3.captured).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.fields).toEqual({ api_key: rawSecret });
    expect(JSON.stringify(turn3)).not.toContain(rawSecret);
    expect(turn3.observation?.safe_table).toEqual([["@copy", "b", "Copy [REDACTED]"]]);
    expect("dom" in (turn3.observation ?? {})).toBe(false);
    expect(JSON.stringify(progressEvents)).not.toContain(rawSecret);
    expect(progressEvents[0]?.message).toContain("[REDACTED]");

    // Browser & harness session started only ONCE across all 3 turns.
    expect(browser.start).toHaveBeenCalledTimes(1);
    expect(startHarnessSession).toHaveBeenCalledTimes(1);
    expect(driveCalls).toHaveLength(3);
    expect(driveCalls[0]).toMatchObject({
      url: "https://app.example.test/api-keys",
      facts: { email: "dev@example.test" },
    });
    expect(driveCalls[0]?.session_id).toBeUndefined();
    expect(driveCalls[1]).toMatchObject({
      session_id: "sess-stateful-1",
      answer: "Grunt Key",
      facts: { email: "dev@example.test", project: "grunt" },
    });
    expect(driveCalls[1]?.url).toBeUndefined();
    expect(driveCalls[2]).toMatchObject({
      session_id: "sess-stateful-1",
      answer: "full",
      facts: { email: "dev@example.test", project: "grunt" },
    });
    expect(driveCalls[2]?.url).toBeUndefined();

    // Caller facts objects must never be mutated.
    expect(initialFacts).toEqual({ email: "dev@example.test" });
    expect(turn2Facts).toEqual({ project: "grunt" });

    // Even after completion, caller owns close(); concurrent/repeated close() tears down exactly once.
    expect(finishSession).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    await Promise.all([session.close(), session.close()]);
    await session.close();

    expect(session.closed).toBe(true);
    expect(session.sessionId).toBeNull();
    expect(finishSession).toHaveBeenCalledTimes(1);
    expect(finishSession).toHaveBeenCalledWith("sess-stateful-1");
    expect(forceFinishSession).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledWith({ cancelStart: true });

    // Further calls on a closed session reject cleanly.
    await expect(session.drive({ goal: "After close" })).rejects.toSatisfy(
      (err: unknown) => err instanceof SignupConfigError && err.code === "session_closed",
    );
    await expect(session.click("@btn")).rejects.toSatisfy(
      (err: unknown) => err instanceof SignupConfigError && err.code === "session_closed",
    );
    await expect(session.observe()).rejects.toSatisfy(
      (err: unknown) => err instanceof SignupConfigError && err.code === "session_closed",
    );
  });

  it("keeps browser and session open on budget, evaluate_timeout, awaiting_human, stuck, and no_progress statuses", async () => {
    const appProfileDir = join(tempDir, "stateful-nonterminal-profile");
    const statuses = [
      "budget",
      "evaluate_timeout",
      "awaiting_human",
      "stuck",
      "no_progress",
    ] as const;
    const browser = makeFakeBrowser();
    const finishSession = vi.fn(async () => ({
      session_id: "sess-nonterm",
      operation_id: "op-nonterm",
      execution: "completed" as const,
      mutation: "not_dispatched" as const,
      cleanup: "closed" as const,
      closed: true,
      url: "https://app.example.test/signup",
    }));
    const forceFinishSession = vi.fn(async () => true);
    let callIndex = 0;

    const session = await createSignupSession(
      {
        url: "https://app.example.test/signup",
        profileDir: appProfileDir,
        session: SAMPLE_SESSION,
        onCredentialCaptured: vi.fn(),
      },
      {
        createBrowser: () => browser as unknown as BrowserController,
        startHarnessSession: async (opts) => ({ session_id: "sess-nonterm", url: opts.serviceUrl }),
        finishSession,
        forceFinishSession,
        runDrive: async (args, _api, _ctx, deps) => {
          const status = statuses[callIndex]!;
          callIndex += 1;
          if (args.session_id === undefined) {
            await deps!.startSession({ serviceUrl: args.url! });
          }
          return makeHandoff({ session_id: "sess-nonterm", status });
        },
      },
    );

    for (const status of statuses) {
      const res = await session.drive({ goal: "Continue signup" });
      expect(res.driveStatus).toBe(status);
      expect(finishSession).not.toHaveBeenCalled();
      expect(forceFinishSession).not.toHaveBeenCalled();
      expect(browser.close).not.toHaveBeenCalled();
    }

    await session.close();
    expect(finishSession).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("supports safe click(ref) and observe() on the active session without closing, and strips dom / redacts secrets", async () => {
    const appProfileDir = join(tempDir, "stateful-click-observe-profile");
    const secret = "sk_live_CLICK_OBSERVE_SECRET_112233";
    const browser = makeFakeBrowser();
    const finishSession = vi.fn(async () => ({
      session_id: "sess-click",
      operation_id: "op-click",
      execution: "completed" as const,
      mutation: "not_dispatched" as const,
      cleanup: "closed" as const,
      closed: true,
      url: "https://app.example.test/oauth/consent",
    }));
    const actMock = vi.fn(async (sid, action) => {
      expect(sid).toBe("sess-click");
      expect(action).toEqual({ kind: "click", target: "@accept-terms" });
      return {
        session_id: sid,
        url: "https://app.example.test/oauth/approved",
        safe_table: [["@continue", "b", `Continue ${secret}`]] as unknown as NonNullable<
          DriveHandoff["observation"]
        >["safe_table"],
        navigated: true as const,
        dom: `Full raw DOM ${secret}`,
      };
    });
    const observeMock = vi.fn(async (sid) => ({
      session_id: sid,
      url: "https://app.example.test/oauth/consent",
      safe_table: [["@accept-terms", "c", `Accept terms ${secret}`]] as unknown as NonNullable<
        DriveHandoff["observation"]
      >["safe_table"],
      dom: `Raw DOM ${secret}`,
    }));

    const session = await createSignupSession(
      {
        url: "https://app.example.test/oauth/consent",
        profileDir: appProfileDir,
        session: SAMPLE_SESSION,
        onCredentialCaptured: vi.fn(),
      },
      {
        createBrowser: () => browser as unknown as BrowserController,
        startHarnessSession: async (opts) => ({ session_id: "sess-click", url: opts.serviceUrl }),
        finishSession,
        act: actMock as unknown as NonNullable<SignupRunRuntime["act"]>,
        observe: observeMock as unknown as NonNullable<SignupRunRuntime["observe"]>,
        runDrive: async (args, _api, context, deps) => {
          await deps!.startSession({ serviceUrl: args.url! });
          await context!.persistLogin!({
            sessionId: "sess-click",
            url: args.url!,
            login: "dev@example.test",
            password: secret,
          });
          return makeHandoff({ status: "low_confidence", session_id: "sess-click" });
        },
      },
    );

    // Calling click/observe before the first drive() fails clearly.
    await expect(session.click("@accept-terms")).rejects.toSatisfy(
      (err: unknown) => err instanceof SignupConfigError && err.code === "session_not_started",
    );
    await expect(session.observe()).rejects.toSatisfy(
      (err: unknown) => err instanceof SignupConfigError && err.code === "session_not_started",
    );

    await session.drive({ goal: "Sign up" });

    const observed = await session.observe();
    expect(observeMock).toHaveBeenCalledWith("sess-click", "compact");
    expect(observed).toEqual({
      url: "https://app.example.test/oauth/consent",
      safe_table: [["@accept-terms", "c", "Accept terms [REDACTED]"]],
    });
    expect("dom" in observed).toBe(false);
    expect(JSON.stringify(observed)).not.toContain(secret);

    const clicked = await session.click("@accept-terms");
    expect(actMock).toHaveBeenCalledTimes(1);
    expect(clicked).toEqual({
      url: "https://app.example.test/oauth/approved",
      safe_table: [["@continue", "b", "Continue [REDACTED]"]],
      navigated: true,
    });
    expect("dom" in clicked).toBe(false);
    expect(JSON.stringify(clicked)).not.toContain(secret);
    expect(finishSession).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();

    await session.close();
    expect(finishSession).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("tears down provision session and browser exactly once when session AbortSignal fires (and when close() is also called)", async () => {
    const appProfileDir = join(tempDir, "stateful-abort-profile");
    const controller = new AbortController();
    const browser = makeFakeBrowser();
    const finishSession = vi.fn(async () => ({
      session_id: "sess-abort-once",
      operation_id: "op-abort-once",
      execution: "completed" as const,
      mutation: "not_dispatched" as const,
      cleanup: "closed" as const,
      closed: true,
      url: "https://app.example.test/signup",
    }));
    const forceFinishSession = vi.fn(async () => true);

    const session = await createSignupSession(
      {
        url: "https://app.example.test/signup",
        profileDir: appProfileDir,
        session: SAMPLE_SESSION,
        signal: controller.signal,
        onCredentialCaptured: vi.fn(),
      },
      {
        createBrowser: () => browser as unknown as BrowserController,
        startHarnessSession: async (opts) => ({
          session_id: "sess-abort-once",
          url: opts.serviceUrl,
        }),
        finishSession,
        forceFinishSession,
        runDrive: async (args, _api, context, deps) => {
          await deps!.startSession({ serviceUrl: args.url! });
          controller.abort(new Error("session aborted by caller"));
          if (context?.signal?.aborted) throw context.signal.reason;
          return makeHandoff({ session_id: "sess-abort-once" });
        },
      },
    );

    const result = await session.drive({ goal: "Sign up" });
    expect(result.status).toBe("cancelled");
    expect(result.reason).toContain("session aborted by caller");
    expect(session.closed).toBe(true);

    // Calling close() again in a finally block must remain strictly idempotent.
    await session.close();
    expect(finishSession).toHaveBeenCalledTimes(1);
    expect(finishSession).toHaveBeenCalledWith("sess-abort-once");
    expect(forceFinishSession).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledWith({ cancelStart: true });
  });

  it("returns cancelled and tears down provision session and browser exactly once when AbortSignal fires mid-drive and runDrive returns normally", async () => {
    const appProfileDir = join(tempDir, "stateful-abort-return-profile");
    const controller = new AbortController();
    const browser = makeFakeBrowser();
    const finishSession = vi.fn(async () => ({
      session_id: "sess-abort-return",
      operation_id: "op-abort-return",
      execution: "completed" as const,
      mutation: "not_dispatched" as const,
      cleanup: "closed" as const,
      closed: true,
      url: "https://app.example.test/signup",
    }));
    const forceFinishSession = vi.fn(async () => true);

    const session = await createSignupSession(
      {
        url: "https://app.example.test/signup",
        profileDir: appProfileDir,
        session: SAMPLE_SESSION,
        signal: controller.signal,
        onCredentialCaptured: vi.fn(),
      },
      {
        createBrowser: () => browser as unknown as BrowserController,
        startHarnessSession: async (opts) => ({
          session_id: "sess-abort-return",
          url: opts.serviceUrl,
        }),
        finishSession,
        forceFinishSession,
        runDrive: async (args, _api, _context, deps) => {
          await deps!.startSession({ serviceUrl: args.url! });
          controller.abort(new Error("aborted while drive returned normally"));
          return makeHandoff({
            status: "stuck",
            session_id: "sess-abort-return",
            reason: "drive saw closed page",
          });
        },
      },
    );

    const result = await session.drive({ goal: "Sign up" });
    expect(result.status).toBe("cancelled");
    expect(result.reason).toContain("aborted while drive returned normally");
    expect(session.closed).toBe(true);
    expect(session.sessionId).toBeNull();
    expect(finishSession).toHaveBeenCalledTimes(1);
    expect(finishSession).toHaveBeenCalledWith("sess-abort-return");
    expect(forceFinishSession).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledWith({ cancelStart: true });

    await session.close();
    expect(finishSession).toHaveBeenCalledTimes(1);
    expect(forceFinishSession).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("falls back to forceFinishSession when finishSession fails, and enforces vault & profile/session isolation", async () => {
    const xdgDir = join(tempDir, "xdg-config");
    vi.stubEnv("XDG_CONFIG_HOME", xdgDir);

    // Personal profile and personal session store remain forbidden on createSignupSession.
    await expect(
      createSignupSession({
        url: "https://app.example.test/signup",
        profileDir: CHROME_PROFILE_DIR,
        session: SAMPLE_SESSION,
        onCredentialCaptured: vi.fn(),
      }),
    ).rejects.toThrow(SignupProfileIsolationError);

    await expect(
      createSignupSession({
        url: "https://app.example.test/signup",
        profileDir: join(tempDir, "isolated-profile"),
        sessionPath: join(xdgDir, "trusty-squire", "session.json"),
        onCredentialCaptured: vi.fn(),
      }),
    ).rejects.toThrow(SignupSessionIsolationError);

    // Hosted vault writes remain forbidden and forceFinishSession runs if finishSession fails.
    const browser = makeFakeBrowser();
    const storeCredentialSpy = vi.fn();
    const finishSession = vi.fn(async () => {
      throw new Error("finish hung");
    });
    const forceFinishSession = vi.fn(async () => true);

    const session = await createSignupSession(
      {
        url: "https://app.example.test/signup",
        profileDir: join(tempDir, "isolated-profile"),
        session: SAMPLE_SESSION,
        onCredentialCaptured: vi.fn(),
      },
      {
        createBrowser: () => browser as unknown as BrowserController,
        createApiClient: () =>
          ({
            setRequestingAgent: vi.fn(),
            storeCredential: storeCredentialSpy,
          }) as unknown as ApiClient,
        startHarnessSession: async (opts) => ({
          session_id: "sess-force-close",
          url: opts.serviceUrl,
        }),
        finishSession,
        forceFinishSession,
        runDrive: async (args, api, _ctx, deps) => {
          await expect(
            api!.storeCredential({ service: "example", value: "sk_live_forbidden" }),
          ).rejects.toThrow(/forbids writing credentials/i);
          expect(storeCredentialSpy).not.toHaveBeenCalled();
          await deps!.startSession({ serviceUrl: args.url! });
          return makeHandoff({ status: "needs_value", session_id: "sess-force-close" });
        },
      },
    );

    await session.drive({ goal: "Sign up" });
    await session.close();
    expect(finishSession).toHaveBeenCalledTimes(1);
    expect(forceFinishSession).toHaveBeenCalledTimes(1);
    expect(forceFinishSession).toHaveBeenCalledWith("sess-force-close");
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});
