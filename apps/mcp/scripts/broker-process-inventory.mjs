import { readdir, readFile } from "node:fs/promises";

/** Linux normally preserves argv boundaries. Chrome can rewrite argv[0] into
 * a process title; recognize that representation without substring matching. */
export function parseProcCmdline(bytes) {
  const argv = Buffer.from(bytes).toString("utf8").split("\0").filter(Boolean);
  if (argv.length !== 1 || !argv[0].includes(" --")) return argv;
  const tokens = argv[0].match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.map((token) =>
    token.replace(/"([^"]*)"|'([^']*)'/g, (_, double, single) => double ?? single),
  );
}

export async function processInventory(profile) {
  const owned = [];
  const chromeRoots = [];
  const gone = (error) => ["ENOENT", "ESRCH"].includes(error.code);
  for (const pid of (await readdir("/proc")).filter((id) => /^\d+$/.test(id))) {
    let argv;
    try {
      argv = parseProcCmdline(await readFile(`/proc/${pid}/cmdline`));
    } catch (error) {
      if (gone(error)) continue;
      throw error;
    }
    const profileArgument = argv.includes(`--user-data-dir=${profile}`);
    let env = "";
    try {
      env = await readFile(`/proc/${pid}/environ`, "utf8");
    } catch (error) {
      if (gone(error)) continue;
      // Other users' environments are private. A matching Chrome must remain
      // visible in the inventory even when its environment is inaccessible.
      if (!["EACCES", "EPERM"].includes(error.code)) throw error;
    }
    if (profileArgument || env.split("\0").includes(`TRUSTY_SQUIRE_PROFILE_DIR=${profile}`))
      owned.push(Number(pid));
    if (profileArgument && !argv.some((arg) => arg.startsWith("--type=")))
      chromeRoots.push(Number(pid));
  }
  return { owned: owned.sort((a, b) => a - b), chromeRoots: chromeRoots.sort((a, b) => a - b) };
}
