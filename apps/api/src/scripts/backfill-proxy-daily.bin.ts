import process from "node:process";
import { main } from "./backfill-proxy-daily.js";

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error("[proxy-daily] failed:", err);
  process.exit(1);
});
