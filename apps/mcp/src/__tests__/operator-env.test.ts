import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadHarvesterEnvFile } from "../operator-env.js";

const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalHeadless = process.env.UNIVERSAL_BOT_HEADLESS;
const originalProxy = process.env.UNIVERSAL_BOT_PROXY_URL;
let tempConfigHome: string | undefined;

afterEach(async () => {
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
  if (originalHeadless === undefined) delete process.env.UNIVERSAL_BOT_HEADLESS;
  else process.env.UNIVERSAL_BOT_HEADLESS = originalHeadless;
  if (originalProxy === undefined) delete process.env.UNIVERSAL_BOT_PROXY_URL;
  else process.env.UNIVERSAL_BOT_PROXY_URL = originalProxy;
  if (tempConfigHome !== undefined) {
    await fs.rm(tempConfigHome, { recursive: true, force: true });
    tempConfigHome = undefined;
  }
});

describe("loadHarvesterEnvFile", () => {
  it("loads remaining bot settings but ignores the retired proxy fallback", async () => {
    tempConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "ts-operator-env-"));
    const configDir = path.join(tempConfigHome, "trusty-squire");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "harvester.env"),
      "UNIVERSAL_BOT_HEADLESS=true\nUNIVERSAL_BOT_PROXY_URL=http://user:secret@proxy.test\n",
    );
    process.env.XDG_CONFIG_HOME = tempConfigHome;
    delete process.env.UNIVERSAL_BOT_HEADLESS;
    delete process.env.UNIVERSAL_BOT_PROXY_URL;

    loadHarvesterEnvFile();

    expect(process.env.UNIVERSAL_BOT_HEADLESS).toBe("true");
    expect(process.env.UNIVERSAL_BOT_PROXY_URL).toBeUndefined();
  });
});
