// Operator CLI for the drainable failure ledger (memory-overhaul Phase 4) +
// the STATE.md generator. These are operator-only (REGISTRY_ADMIN_BEARER),
// excluded from the published tarball with the rest of the housekeeper.
//
//   mcp housekeeper issue list [--status open]
//   mcp housekeeper issue show <id>
//   mcp housekeeper issue claim <id> --actor <a>
//   mcp housekeeper issue resolve <id> --run <provision_id> --actor <a>
//   mcp housekeeper issue wall <id> --experiment <e> --result <r> [--evidence <ref>] --actor <a>
//   mcp housekeeper state-doc [--out STATE.generated.md]
//
// The close commands (resolve/wall) fetch the current version first, so the
// operator doesn't have to track it — but the SERVER still enforces the gate
// (no resolve without a run, no wall without a falsification) and optimistic
// concurrency, so a racing worker is rejected, not silently overwritten.

import { writeFileSync } from "node:fs";
import {
  VerifierRegistryClient,
  type IssueRow,
  type ServiceStateRow,
} from "../registry-client.js";

const DEFAULT_REGISTRY_URL = "https://registry.trustysquire.ai";

function clientFromEnv(): VerifierRegistryClient | { error: string } {
  const adminBearer = process.env.REGISTRY_ADMIN_BEARER;
  if (adminBearer === undefined || adminBearer.length === 0) {
    return { error: "REGISTRY_ADMIN_BEARER is not set (operator-only command)." };
  }
  return new VerifierRegistryClient({
    baseUrl: process.env.TRUSTY_SQUIRE_REGISTRY_URL ?? DEFAULT_REGISTRY_URL,
    adminBearer,
  });
}

// Tiny flag reader: `--key value` and `--key=value`.
function flag(argv: readonly string[], key: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`--${key}=`));
  if (eq !== undefined) return eq.slice(key.length + 3);
  const i = argv.indexOf(`--${key}`);
  return i !== -1 ? argv[i + 1] : undefined;
}

function fmtIssue(i: IssueRow): string {
  const ev =
    i.status === "resolved"
      ? ` resolved_run=${i.resolved_run ?? "?"}`
      : i.status === "wall"
        ? ` wall="${i.falsified?.experiment ?? "?"}→${i.falsified?.result ?? "?"}"`
        : "";
  return `  [${i.status}] ${i.id}  attempts=${i.attempts} v=${i.version}${ev}`;
}

export async function runLedgerCli(argv: readonly string[]): Promise<number> {
  const sub = argv[0];
  const c = clientFromEnv();
  if ("error" in c) {
    console.error(`[ledger] ${c.error}`);
    return 3;
  }

  if (sub === "state-doc") {
    return runStateDoc(c, argv.slice(1));
  }

  if (sub !== "issue") {
    console.error(
      "usage: mcp housekeeper issue <list|show|claim|resolve|wall> … | state-doc",
    );
    return 2;
  }

  const action = argv[1];
  const id = argv[2];
  const actor = flag(argv, "actor") ?? `op-${process.pid}`;

  try {
    switch (action) {
      case "list": {
        const status = flag(argv, "status") as IssueRow["status"] | undefined;
        const issues = await c.listIssues(status);
        if (issues.length === 0) {
          console.log("No issues" + (status !== undefined ? ` (status=${status})` : "") + ".");
          return 0;
        }
        console.log(`${issues.length} issue(s):`);
        for (const i of issues) console.log(fmtIssue(i));
        return 0;
      }
      case "show": {
        if (id === undefined) return usage("show <id>");
        const issue = await c.getIssue(id);
        if (issue === null) {
          console.error(`Issue not found: ${id}`);
          return 1;
        }
        console.log(JSON.stringify(issue, null, 2));
        return 0;
      }
      case "claim": {
        if (id === undefined) return usage("claim <id> --actor <a>");
        const cur = await c.getIssue(id);
        if (cur === null) return notFound(id);
        return report(await c.claimIssue(id, actor, cur.version), id);
      }
      case "resolve": {
        if (id === undefined) return usage("resolve <id> --run <provision_id> --actor <a>");
        const run = flag(argv, "run");
        if (run === undefined) {
          console.error("resolve requires --run <provision_id> (the green run that proves it).");
          return 2;
        }
        const cur = await c.getIssue(id);
        if (cur === null) return notFound(id);
        return report(await c.resolveIssue(id, actor, cur.version, run), id);
      }
      case "wall": {
        if (id === undefined) {
          return usage('wall <id> --experiment "<e>" --result "<r>" [--evidence <ref>] --actor <a>');
        }
        const experiment = flag(argv, "experiment");
        const result = flag(argv, "result");
        if (experiment === undefined || result === undefined) {
          console.error(
            "wall requires --experiment and --result (the falsification that proves the wall). " +
              "No wall without evidence — that's the gate.",
          );
          return 2;
        }
        const evidence = flag(argv, "evidence");
        const cur = await c.getIssue(id);
        if (cur === null) return notFound(id);
        return report(
          await c.wallIssue(id, actor, cur.version, {
            experiment,
            result,
            ...(evidence !== undefined ? { evidence_ref: evidence } : {}),
          }),
          id,
        );
      }
      default:
        return usage("<list|show|claim|resolve|wall>");
    }
  } catch (err) {
    console.error(`[ledger] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function usage(s: string): number {
  console.error(`usage: mcp housekeeper issue ${s}`);
  return 2;
}
function notFound(id: string): number {
  console.error(`Issue not found: ${id}`);
  return 1;
}

function report(
  r:
    | { kind: "ok"; issue: IssueRow }
    | { kind: "not_found" }
    | { kind: "version_conflict"; current: number }
    | { kind: "missing_evidence"; need: string },
  id: string,
): number {
  switch (r.kind) {
    case "ok":
      console.log(`✅ ${id} → ${r.issue.status} (v${r.issue.version})`);
      return 0;
    case "not_found":
      return notFound(id);
    case "version_conflict":
      console.error(
        `⚠ ${id}: version conflict — another worker moved it (now v${r.current}). Re-fetch and retry.`,
      );
      return 1;
    case "missing_evidence":
      console.error(`⛔ ${id}: the close-gate rejected this — missing ${r.need}.`);
      return 1;
  }
}

// STATE.md generator — projects the materialized ServiceState into a grouped
// markdown section. Replaces the hand-written status narrative with a
// generated view (the diagnosis overlay carries what the projection can't).
async function runStateDoc(
  c: VerifierRegistryClient,
  argv: readonly string[],
): Promise<number> {
  const states = await c.listServiceStates();
  const md = renderStateDoc(states);
  const out = flag(argv, "out");
  if (out !== undefined) {
    writeFileSync(out, md);
    console.log(`Wrote ${states.length} service states → ${out}`);
  } else {
    process.stdout.write(md);
  }
  return 0;
}

export function renderStateDoc(states: readonly ServiceStateRow[]): string {
  // Worst-first: a heal-set wall/unservable overlay ranks above the projection
  // states (it's a human/heal judgment that the service needs attention).
  const order = [
    "unservable",
    "wall",
    "hard-block",
    "struggling",
    "working",
    "skill-active",
  ];
  const byStatus = new Map<string, ServiceStateRow[]>();
  for (const s of states) {
    const k = s.wall_classification ?? s.status;
    (byStatus.get(k) ?? byStatus.set(k, []).get(k)!).push(s);
  }
  const lines: string[] = [
    "# Service status (generated from ServiceState — do not hand-edit)",
    "",
    `${states.length} service(s). Grouped worst-first. Diagnosis is the heal-written overlay.`,
    "",
  ];
  const groups = [...byStatus.keys()].sort(
    (a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99),
  );
  for (const g of groups) {
    const rows = (byStatus.get(g) ?? []).sort((a, b) => a.confidence - b.confidence);
    lines.push(`## ${g} (${rows.length})`, "");
    for (const s of rows) {
      const diag = s.current_diagnosis !== null ? ` — ${s.current_diagnosis}` : "";
      const last =
        s.last_failure_kind !== null ? ` last_failure=${s.last_failure_kind}` : "";
      lines.push(
        `- **${s.service}** score=${s.confidence.toFixed(2)} ` +
          `(${s.successful_count}✓/${s.failed_count}✗)${last}${diag}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
