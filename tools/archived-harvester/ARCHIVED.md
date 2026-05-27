# Archived — see `mcp housekeeper`

The functionality of this tool was merged into `mcp housekeeper` on
2026-05-26. The new tool unifies the verifier (registry-driven
pending-review + freshness sweep), the discoverer (telemetry-driven
candidate iteration), and the harvester (curated services.yaml
iteration) under one CLI with `--queue=` modes.

To run the equivalent of the old harvester:

```bash
node apps/mcp/dist/bin.js housekeeper \
  --queue=seed \
  --from=tools/archived-harvester/services.yaml \
  --telegram \
  --github-issues \
  --once
```

`services.yaml` stays here as the canonical curated list — the
housekeeper reads it directly via `--from=`. Other files in this
directory are preserved for forensic reference only.

Source of truth for the merged tool: `apps/mcp/src/housekeeper/`.
