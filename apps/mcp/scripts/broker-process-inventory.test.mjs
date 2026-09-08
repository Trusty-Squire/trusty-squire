import { test } from "vitest";
import assert from "node:assert/strict";
import { parseProcCmdline } from "./broker-process-inventory.mjs";
test("preserves NUL-delimited argv including spaces inside profile paths", () => {
  assert.deepEqual(
    parseProcCmdline(Buffer.from("/opt/chrome\0--user-data-dir=/test profile\0--type=renderer\0")),
    ["/opt/chrome", "--user-data-dir=/test profile", "--type=renderer"],
  );
});
test("recognizes Chrome's rewritten process title and exact argument boundaries", () => {
  assert.deepEqual(
    parseProcCmdline(Buffer.from('/opt/chrome --user-data-dir="/test profile" --type=zygote\0')),
    ["/opt/chrome", "--user-data-dir=/test profile", "--type=zygote"],
  );
  assert.deepEqual(
    parseProcCmdline(Buffer.from("/opt/chrome --user-data-dir=/test/profile --no-sandbox\0")),
    ["/opt/chrome", "--user-data-dir=/test/profile", "--no-sandbox"],
  );
});
