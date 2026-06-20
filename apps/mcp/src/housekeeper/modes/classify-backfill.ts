import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCaptureDir } from "../../bot/onboarding-capture.js";
import { buildClassificationBackfill } from "../cluster-classification.js";
import { readFixBatch } from "../fix-batch.js";

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

function currentGitCommit(repoRoot: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

export function runClassificationBackfill(opts: {
  log?: (line: string) => void;
  outPath?: string;
} = {}): number {
  const log = opts.log ?? ((line: string) => console.log(`[classify-backfill] ${line}`));
  const captureDir = resolveCaptureDir();
  if (captureDir === null) {
    log("no capture dir resolved");
    return 1;
  }
  const repoRoot = process.cwd();
  const currentCommit = currentGitCommit(repoRoot);
  const generatedAt = new Date().toISOString();
  const batch = readFixBatch(
    captureDir,
    {
      batchId: `classify-${Date.now().toString(36)}`,
      botVersion: "classifier",
      generatedAt,
    },
    Date.now() - SIXTY_DAYS_MS,
  );
  const backfill = buildClassificationBackfill({
    batch,
    generatedAt,
    ...(currentCommit !== undefined ? { currentCommit } : {}),
  });
  const outPath = opts.outPath ?? join(captureDir, "cluster-classification.backfill.json");
  writeFileSync(outPath, `${JSON.stringify(backfill, null, 2)}\n`);
  log(`wrote ${backfill.total_failures} classified failure(s) to ${outPath}`);
  for (const bucket of backfill.buckets) {
    log(`${bucket.bucket}: ${bucket.failures} failure(s), ${bucket.services.length} service(s)`);
  }
  return 0;
}
