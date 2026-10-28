import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Keep navigation inside Chrome. External application prompts are not JS
// dialogs: CDP clicks return success while Chrome silently drops their input.
const BROWSER_URL_PATTERNS = [
  "http://*",
  "https://*",
  "about:*",
  "blob:*",
  "data:*",
  "file://*",
  "filesystem:*",
  "javascript:*",
  "view-source:*",
  "chrome:*",
  "chrome-untrusted:*",
  "chrome-extension:*",
  "devtools:*",
];

/** Call only before launching the owned profile, never while Chrome is live. */
export async function prepareBrowserProtocolPolicy(profileDir: string): Promise<void> {
  const directory = join(profileDir, "Default");
  const path = join(directory, "Preferences");
  let preferences: Record<string, unknown> = {};
  try {
    preferences = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (preferences === null || typeof preferences !== "object" || Array.isArray(preferences))
    throw new Error("Invalid Chrome preferences");
  const policy = preferences.policy ?? {};
  if (policy === null || typeof policy !== "object" || Array.isArray(policy))
    throw new Error("Invalid Chrome navigation policy");
  const existing = policy as Record<string, unknown>;
  const list = (name: string): string[] => {
    const value = existing[name] ?? [];
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string"))
      throw new Error("Invalid Chrome navigation policy list");
    return value;
  };
  preferences.policy = {
    ...existing,
    url_blocklist: [...new Set([...list("url_blocklist"), "*"])],
    url_allowlist: [...new Set([...list("url_allowlist"), ...BROWSER_URL_PATTERNS])],
  };
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.protocol-policy-${randomUUID()}`);
  await writeFile(temporary, JSON.stringify(preferences), { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}
