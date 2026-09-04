import { writeFileSync } from "node:fs";
import { runOwnerProcessReaperWorker } from "./owner-process-reaper.js";

const manifestPath = process.argv[2];
const readyPath = process.argv[3];
const token = process.argv[4];
if (manifestPath === undefined || readyPath === undefined || token === undefined) process.exit(2);

runOwnerProcessReaperWorker(manifestPath, () => {
  writeFileSync(readyPath, `${JSON.stringify({ version: 1, token, pid: process.pid })}\n`, {
    mode: 0o600,
    flag: "wx",
  });
}).then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `[trusty-squire] owner reaper failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exit(1);
  },
);
