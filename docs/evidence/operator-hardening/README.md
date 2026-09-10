# Isolated operator performance evidence

`performance.json` records the local RC.10 comparison: five warmups and 30
observations for each fixed synthetic fixture and mode, on the same machine.
The harness retains delta DOM for full-read recall and checks query aliases with
their actionable roles. CPU figures are Node process CPU time; browser task time
and JavaScript heap metrics come from CDP. These are local fixture measurements,
not provider latency or live qualification claims.

Build both checkouts with their MCP `tsconfig.build.json`, then run the same
`apps/mcp/scripts/observation-performance.mjs` directly in Node with an isolated
HOME/config and installed Playwright binaries. First select the exact baseline
`ee3ee9abaa4b4e3319025dd785c3027ca02fd18c` using `--source-root <baseline-checkout>
--out <baseline.json>`. Then select the integrated checkout with
`--source-root <integrated-checkout> --baseline <baseline.json> --out <result.json>`.
Keep runs serial. The script checks labeled task-control recall, p95 <=2 seconds,
and (when baseline is supplied) p95 <=1.2 times baseline.

The fixture routes all browser requests to synthetic HTML. It neither uses a
real profile nor contacts a provider. Native-host and fresh Resend/Neon acceptance
remain separate evidence described in `docs/operator-acceptance-runbook.md` and
`docs/browser-broker.md`.
