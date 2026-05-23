// MCP session storage.
//
// Prefer keytar (OS keychain) when available. Fall back to a 0600
// file at $XDG_CONFIG_HOME/trusty-squire/session.json (or
// ~/.config/trusty-squire/session.json) so the install works on
// minimal Linux containers and CI machines without libsecret.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const KEYTAR_SERVICE = "trusty-squire";
const KEYTAR_ACCOUNT = "session";

// rc.21 — DO NOT cache the fallback path at module-load time. Tests
// sandbox via beforeEach { process.env.HOME = tmpdir }; a path cached
// at import time captures the REAL ~/.config/trusty-squire/ and the
// test then writes the test-fixture session.json to the user's actual
// home, destroying live credentials. Resolve per-call so the env
// override in effect at write-time wins.
function resolveFallbackFile(): string {
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "trusty-squire",
    "session.json",
  );
}

// Session storage holds the account-bound credentials the squire needs
// to act on a user's behalf:
//   - machine_token: bot-internal credential for the LLM proxy + inbox
//     alias service, bound to the account at claim time.
//   - agent_session_token: bearer token the MCP server presents on
//     vault writes, mandate-aware tool calls, and any other authed API
//     surface.
//   - account_id: the account the install is bound to.
//
// Fields stay optional in the type so the install CLI can write a
// transient session with just machine_token while the browser claim is
// in flight. At tool-call time, every field is required — missing
// fields surface a "re-install" message.
export interface SessionData {
  api_base_url: string;
  saved_at: string;
  machine_token?: string;
  agent_session_token?: string;
  account_id?: string;
}

export interface SessionStorage {
  read(): Promise<SessionData | null>;
  write(data: SessionData): Promise<void>;
  clear(): Promise<void>;
  backendName(): string;
}

// Tries keytar first. Falls back to the file backend if keytar isn't
// installed or its native binding can't load. The fallback is also the
// chosen backend for CI / tests.
export async function openSessionStorage(
  options: { preferFile?: boolean } = {},
): Promise<SessionStorage> {
  if (options.preferFile !== true) {
    const keytar = await tryLoadKeytar();
    if (keytar !== null) return new KeytarStorage(keytar);
  }
  return new FileStorage();
}

async function tryLoadKeytar(): Promise<KeytarShape | null> {
  // Two things can fail here:
  //   1. The module itself can't load (no native binding for this Node
  //      version, or the package isn't installed).
  //   2. The module loads but the OS keychain isn't available (no
  //      D-Bus secrets daemon on a headless Linux box, locked Keychain
  //      on macOS, etc.) — load succeeds, the first call throws.
  // Probe with a write to a throwaway entry: getPassword() can succeed
  // (returning null) on a half-broken D-Bus where the secrets service
  // is present but no collection is unlocked — only setPassword
  // surfaces that. We delete the probe right after so we don't pollute
  // the keychain.
  try {
    const mod: KeytarModule = await import("keytar");
    const probeAccount = `${KEYTAR_ACCOUNT}__probe`;
    await mod.default.setPassword(KEYTAR_SERVICE, probeAccount, "1");
    await mod.default.deletePassword(KEYTAR_SERVICE, probeAccount);
    return {
      getPassword: mod.default.getPassword,
      setPassword: mod.default.setPassword,
      deletePassword: mod.default.deletePassword,
    };
  } catch {
    return null;
  }
}

interface KeytarShape {
  getPassword: (service: string, account: string) => Promise<string | null>;
  setPassword: (service: string, account: string, password: string) => Promise<void>;
  deletePassword: (service: string, account: string) => Promise<boolean>;
}

interface KeytarModule {
  default: KeytarShape;
}

class KeytarStorage implements SessionStorage {
  constructor(private readonly kt: KeytarShape) {}

  async read(): Promise<SessionData | null> {
    const raw = await this.kt.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as SessionData;
    } catch {
      return null;
    }
  }

  async write(data: SessionData): Promise<void> {
    await this.kt.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, JSON.stringify(data));
  }

  async clear(): Promise<void> {
    await this.kt.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
  }

  backendName(): string {
    return "keytar";
  }
}

export class FileStorage implements SessionStorage {
  private readonly filePath: string;
  // Allow tests to override the default file path. When no override is
  // supplied, resolve the path NOW (constructor invocation) instead of
  // capturing a value cached at module-import time — see
  // resolveFallbackFile's comment.
  constructor(filePath?: string) {
    this.filePath = filePath ?? resolveFallbackFile();
  }

  async read(): Promise<SessionData | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(raw) as SessionData;
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return null;
      throw err;
    }
  }

  async write(data: SessionData): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
  }

  backendName(): string {
    return "file";
  }
}
