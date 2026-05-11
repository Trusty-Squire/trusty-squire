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

const FALLBACK_DIR = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "trusty-squire",
);
const FALLBACK_FILE = path.join(FALLBACK_DIR, "session.json");

export interface SessionData {
  agent_session_token: string;
  account_id: string;
  api_base_url: string;
  saved_at: string;
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
  try {
    const mod: KeytarModule = await import("keytar");
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
  // Allow tests to override the default file path.
  constructor(private readonly filePath: string = FALLBACK_FILE) {}

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
