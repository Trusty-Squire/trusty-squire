import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, symlink, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { SessionStore } from "../session.js";
import { defaultBrokerSocket, brokerElectionRoot } from "../bot/broker/discovery.js";
import { processBirthIdentityState, profilePathIdentity } from "../bot/profile.js";

export const canRunDefaultBrokerAcceptance =
  process.platform === "linux" && existsSync(chromium.executablePath());

type Owner = { pid: number; start_time: string };
/** The broker holds the profile operation lease for its whole life, so the
 * lease record is where its pid and birth identity are published. */
function brokerLeasePath(profile: string): string {
  const digest = createHash("sha256")
    .update(profilePathIdentity(profile))
    .digest("hex")
    .slice(0, 24);
  return join(brokerElectionRoot(profile), `trusty-squire-profile-${digest}.lock`);
}
async function readLeaseOwner(path: string): Promise<Owner | undefined> {
  const candidate = await readFile(path, "utf8").then(
    (source) => source,
    async () => await readFile(join(path, "owner.json"), "utf8").catch(() => undefined),
  );
  if (candidate === undefined) return undefined;
  const owner = JSON.parse(candidate) as Owner;
  return Number.isSafeInteger(owner.pid) && typeof owner.start_time === "string"
    ? owner
    : undefined;
}
async function waitFor<T>(read: () => Promise<T | undefined>, description: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}`);
}

/** Uses only the compiled package and isolated enrollment; no socket,
 * or forwarder credential setting is supplied to any MCP process. */
export async function checkDefaultBrokerAcceptance(
  distBin: string,
  root: string,
  sourceLoader?: string,
): Promise<void> {
  const profile = join(root, "profile");
  const config = join(root, "config");
  await mkdir(profile, { recursive: true });
  await mkdir(join(root, "home"), { recursive: true });
  await symlink(`${hostname()}-2147483647`, join(profile, "SingletonLock"));
  await new SessionStore(join(config, "trusty-squire", "session.json")).write({
    account_id: "fixture-account",
    agent_session_token: "fixture-token",
    api_base_url: "http://127.0.0.1:1",
    saved_at: new Date().toISOString(),
  });
  const chromeRoots = async () => {
    const processes = await readdir("/proc");
    const matches = await Promise.all(
      processes
        .filter((pid) => /^\d+$/.test(pid))
        .map(async (pid) => {
          const argv = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
          const words = argv.replaceAll("\0", " ").split(" ");
          return (
            words.includes(`--user-data-dir=${profile}`) &&
            !words.some((word) => word.startsWith("--type="))
          );
        }),
    );
    return matches.filter(Boolean).length;
  };
  const socket = defaultBrokerSocket(profile);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !entry[0].startsWith("TRUSTY_SQUIRE_BROKER_") &&
        !["TRUSTY_SQUIRE_FORWARDER_CREDENTIAL", "TRUSTY_SQUIRE_SERVER_LINEAGE"].includes(entry[0]),
    ),
  );
  if (sourceLoader) env.NODE_OPTIONS = `--import ${sourceLoader}`;
  Object.assign(env, {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: config,
    TMPDIR: root,
    TRUSTY_SQUIRE_ACCOUNT_ID: "fixture-account",
    TRUSTY_SQUIRE_PROFILE_DIR: profile,
    TRUSTY_SQUIRE_REAPER_DIR: join(root, "reapers"),
    TRUSTY_SQUIRE_REAPER_POLL_MS: "20",
    TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS: "20",
    UNIVERSAL_BOT_CHANNEL: "chrome",
    UNIVERSAL_BOT_CHROME_BINARY: chromium.executablePath(),
    BOT_CDP_ENDPOINT: "",
  });
  const clients: Client[] = [];
  const sessionOf = new Map<Client, string>();
  let owner: Owner | undefined;
  const readOwner = async (): Promise<Owner | undefined> => {
    try {
      return await readLeaseOwner(brokerLeasePath(profile));
    } catch {
      return undefined;
    }
  };
  const start = async () => {
    const client = new Client({ name: "default-broker-fixture", version: "1" });
    clients.push(client);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distBin, "server"],
      env,
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    await client.connect(transport);
    const result = await client.callTool({
      name: "operate_start",
      arguments: {
        service_url:
          "data:text/html,%3Cform%3E%3Clabel%3EName%3Cinput%20name%3Dname%3E%3C%2Flabel%3E%3C%2Fform%3E",
      },
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ session_id: expect.any(String) });
    expect(result.structuredContent).not.toHaveProperty("needs_user");
    sessionOf.set(client, (result.structuredContent as { session_id: string }).session_id);
    process.stdout.write(
      "default-broker MCP operate_start:" + " " + JSON.stringify(result.structuredContent) + "\n",
    );
    return client;
  };
  try {
    await Promise.all([start(), start(), start()]);
    owner = await waitFor(readOwner, "elected broker");
    expect(processBirthIdentityState(owner)).toBe("matching");
    const initialChromeRoots = await chromeRoots();
    expect(initialChromeRoots).toBe(1);
    process.stdout.write(
      "default-broker concurrent servers:" +
        " " +
        JSON.stringify({ servers: clients.length, owner, chromeRoots: initialChromeRoots }) +
        "\n",
    );
    await Promise.all(clients.splice(0).map(async (client) => await client.close()));
    expect(await readOwner()).toEqual(owner);
    expect(processBirthIdentityState(owner)).toBe("matching");
    process.stdout.write(
      "default-broker after all MCP clients disconnect:" +
        " " +
        JSON.stringify({ owner: await readOwner(), state: processBirthIdentityState(owner) }) +
        "\n",
    );
    process.kill(owner.pid, "SIGKILL");
    await waitFor(
      async () => (processBirthIdentityState(owner!) === "stale" ? true : undefined),
      "dead broker",
    );
    await start();
    const replacement = await waitFor(async () => {
      const next = await readOwner();
      return next?.pid !== owner?.pid ? next : undefined;
    }, "replacement broker");
    expect(replacement.pid).not.toBe(owner.pid);
    owner = replacement;
    const replacementChromeRoots = await chromeRoots();
    expect(replacementChromeRoots).toBe(1);
    process.stdout.write(
      "default-broker after SIGKILL replacement:" +
        " " +
        JSON.stringify({ owner, chromeRoots: replacementChromeRoots }) +
        "\n",
    );
  } finally {
    // Close each remaining session before its client goes: the broker holds a
    // disconnecting client open for the whole session drain, and a SIGTERM that
    // lands inside that window is swallowed by a once-only handler that is
    // never re-armed — the broker then survives to its idle timeout.
    await Promise.all(
      clients.map(async (client) => {
        const sessionId = sessionOf.get(client);
        if (sessionId !== undefined)
          await client
            .callTool({ name: "operate_finish", arguments: { session_id: sessionId } })
            .catch(() => undefined);
        await client.close();
      }),
    );
    // Also find an elected child if a failed start returned before owner capture.
    owner = (await readOwner()) ?? owner;
    if (owner && processBirthIdentityState(owner) === "matching") {
      process.kill(owner.pid, "SIGCONT");
      process.kill(owner.pid, "SIGTERM");
      await waitFor(
        async () => (processBirthIdentityState(owner!) === "stale" ? true : undefined),
        "broker teardown",
      );
    }
    await rm(dirname(socket), { recursive: true, force: true });
  }
}
