import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import {
  canRunDefaultBrokerAcceptance,
  checkDefaultBrokerAcceptance,
} from "./broker-default-acceptance.js";
const require = createRequire(import.meta.url);
it.skipIf(!canRunDefaultBrokerAcceptance)(
  "shares an owned foreground broker across concurrent servers and its replacement",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ts-broker-default-"));
    try {
      await checkDefaultBrokerAcceptance(
        fileURLToPath(new URL("../bin.js", import.meta.url)),
        root,
        require.resolve("tsx"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
