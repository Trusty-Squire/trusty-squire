import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { currentProfileDir, profilePathIdentity } from "../profile-path.js";

export function sharedMcpSocketPath(home = homedir(), profileDir = currentProfileDir()): string {
  const privateDir = join(home, ".trusty-squire");
  const profile = profilePathIdentity(profileDir);
  const canonical = profilePathIdentity(join(privateDir, "chrome-profile"));
  if (profile === canonical) return join(privateDir, "mcp.sock");
  const digest = createHash("sha256").update(profile).digest("hex").slice(0, 16);
  return join(privateDir, `mcp-${digest}.sock`);
}
