import { homedir } from "node:os";
import { join } from "node:path";

export function sharedMcpSocketPath(home = homedir()): string {
  return join(home, ".trusty-squire", "mcp.sock");
}
