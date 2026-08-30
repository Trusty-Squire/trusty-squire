import { runOwnerProcessReaperWorker } from "./owner-process-reaper.js";

const manifestPath = process.argv[2];
if (manifestPath === undefined) process.exit(2);

runOwnerProcessReaperWorker(manifestPath).then(
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
