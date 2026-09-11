import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";

/** Opt-in reviewer evidence from isolated fixtures; never attaches to a user browser. */
export async function fixtureEvidence(name: string, output: unknown, page?: Page) {
  const directory = process.env.MCP_FIXTURE_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.json`), JSON.stringify(output, null, 2));
  if (page) await page.screenshot({ path: join(directory, `${name}.png`) });
}
