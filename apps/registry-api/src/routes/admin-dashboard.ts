// Operator dashboard — closed-loop strategy Phase 7.
//
// One route, `GET /admin`, returns a server-rendered HTML page with
// four sections:
//   - Active skills (status, replay success, last verified)
//   - Pending review (verifier queue)
//   - Discovery candidates (services with ≥3 user failures, no skill)
//   - Recent universal-bot failures (raw telemetry, debug surface)
//
// Auth: same admin-bearer as the JSON admin endpoints. Browsers can't
// easily set Authorization headers without JS, so we accept the
// bearer via `?bearer=…` query string OR Authorization header. The
// query-string path is a tradeoff: it puts the bearer in browser/
// server logs. Acceptable for an operator-only personal admin page
// — rotate the bearer if you bookmark with one.
//
// V1 is read-only. No actions, no JS. Sections rendered as HTML
// tables. Future phases can add demote/reactivate actions; today
// those are CLI-driven.

import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import type { SkillStore } from "../skill-store.js";
import type { BotFailureStore } from "../bot-failure-store.js";

export interface AdminDashboardDeps {
  store: SkillStore;
  botFailureStore?: BotFailureStore;
  adminBearer?: string;
}

export const registerAdminDashboardRoute: FastifyPluginAsync<AdminDashboardDeps> = async (
  fastify: FastifyInstance,
  opts,
) => {
  fastify.get<{ Querystring: { bearer?: string } }>("/admin", async (req, reply) => {
    if (opts.adminBearer === undefined || opts.adminBearer.length === 0) {
      reply.code(503).type("text/plain").send("admin_not_configured");
      return;
    }
    // Bearer in either the Authorization header or the ?bearer query
    // string. The query-string path is for browser bookmarks (browsers
    // can't easily attach Authorization without JS).
    const authHeader = req.headers["authorization"];
    const headerToken =
      typeof authHeader === "string" && authHeader.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length)
        : undefined;
    const presented = req.query.bearer ?? headerToken;
    if (presented !== opts.adminBearer) {
      reply
        .code(401)
        .type("text/plain")
        .send(
          "unauthorized — pass the admin bearer via ?bearer=… or Authorization: Bearer …",
        );
      return;
    }

    // Pull everything serial — these are admin-scale queries on small
    // tables, no need to chase parallelism. If it ever matters we can
    // Promise.all + a single transaction.
    const allSkills = await opts.store.listSkills({ limit: 500 });
    const verifierQueue = await opts.store.listVerifierQueue({ limit: 50 });
    const discoveryCandidates =
      opts.botFailureStore !== undefined
        ? await opts.botFailureStore.listDiscoveryCandidates({
            excludeServices: new Set(
              allSkills.filter((s) => s.status === "active").map((s) => s.service),
            ),
            limit: 50,
          })
        : [];
    // Per-section breakdowns of the skill list — the dashboard sorts
    // them by relevance to the operator's eyeballs.
    const activeSkills = allSkills.filter((s) => s.status === "active");
    const demotedSkills = allSkills.filter((s) => s.status === "demoted");

    const html = renderDashboard({
      activeSkills,
      demotedSkills,
      verifierQueue,
      discoveryCandidates,
    });
    reply.code(200).type("text/html; charset=utf-8").send(html);
  });
};

function renderDashboard(args: {
  activeSkills: Awaited<ReturnType<SkillStore["listSkills"]>>;
  demotedSkills: Awaited<ReturnType<SkillStore["listSkills"]>>;
  verifierQueue: Awaited<ReturnType<SkillStore["listVerifierQueue"]>>;
  discoveryCandidates: Awaited<ReturnType<NonNullable<BotFailureStore>["listDiscoveryCandidates"]>>;
}): string {
  const css = `
    body { font: 14px/1.45 -apple-system, system-ui, sans-serif; max-width: 1100px; margin: 24px auto; padding: 0 16px; color: #1d1d1f; }
    h1 { font-size: 22px; margin-bottom: 8px; }
    nav { margin: 16px 0 24px; }
    nav a { display: inline-block; margin-right: 12px; padding: 4px 10px; border: 1px solid #d2d2d7; border-radius: 6px; text-decoration: none; color: #1d1d1f; font-size: 13px; }
    nav a:hover { background: #f5f5f7; }
    section { margin: 28px 0; padding: 16px; background: #fafafc; border: 1px solid #e5e5ea; border-radius: 8px; }
    section h2 { margin: 0 0 6px; font-size: 16px; }
    section .desc { color: #6e6e73; font-size: 13px; margin-bottom: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #e5e5ea; vertical-align: top; }
    th { font-weight: 600; color: #6e6e73; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .status-active { color: #1f7a3d; font-weight: 600; }
    .status-pending-review { color: #b45f06; font-weight: 600; }
    .status-demoted { color: #b3261e; font-weight: 600; }
    .status-superseded { color: #6e6e73; }
    .empty { color: #6e6e73; font-style: italic; padding: 16px 10px; }
    code { font-family: ui-monospace, monospace; font-size: 12px; background: #f0f0f3; padding: 1px 4px; border-radius: 3px; }
  `;
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"utf-8\" />",
    "  <title>Trusty Squire — Registry Admin</title>",
    `  <style>${css}</style>`,
    "</head>",
    "<body>",
    `  <h1>Trusty Squire — Registry Admin</h1>`,
    `  <nav>`,
    `    <a href="#active">Active (${args.activeSkills.length})</a>`,
    `    <a href="#pending">Pending review (${args.verifierQueue.filter((s) => s.status === "pending-review").length})</a>`,
    `    <a href="#freshness">Freshness due (${args.verifierQueue.filter((s) => s.status === "active").length})</a>`,
    `    <a href="#discovery">Discovery candidates (${args.discoveryCandidates.length})</a>`,
    `    <a href="#demoted">Demoted (${args.demotedSkills.length})</a>`,
    `  </nav>`,
    renderActiveSection(args.activeSkills),
    renderPendingSection(args.verifierQueue),
    renderFreshnessSection(args.verifierQueue),
    renderDiscoverySection(args.discoveryCandidates),
    renderDemotedSection(args.demotedSkills),
    "</body>",
    "</html>",
  ].join("\n");
}

function renderActiveSection(
  skills: Awaited<ReturnType<SkillStore["listSkills"]>>,
): string {
  const active = skills.filter((s) => s.status === "active");
  if (active.length === 0) {
    return section("active", "Active skills", "Promoted, end-user-visible.", `<div class="empty">No active skills yet.</div>`);
  }
  const rows = active.map((s) => {
    const total = s.replays_succeeded + s.replays_failed;
    const rate = total > 0 ? `${Math.round((100 * s.replays_succeeded) / total)}%` : "—";
    return `<tr>
      <td>${esc(s.service)}</td>
      <td>${esc(s.version)}</td>
      <td><code>${esc(s.skill_id.slice(0, 10))}…</code></td>
      <td class="num">${s.replays_succeeded}/${total}</td>
      <td class="num">${rate}</td>
      <td>${dateOrDash(s.last_verified_at)}</td>
      <td>${dateOrDash(s.next_freshness_due_at)}</td>
    </tr>`;
  });
  return section(
    "active",
    "Active skills",
    "Promoted, end-user-visible. The router serves these first; universal bot only fires if the skill replay fails.",
    `<table>
      <thead>
        <tr><th>Service</th><th>Ver.</th><th>ID</th><th>Replays</th><th>Success</th><th>Last verified</th><th>Next sweep</th></tr>
      </thead>
      <tbody>${rows.join("")}</tbody>
    </table>`,
  );
}

function renderPendingSection(
  queue: Awaited<ReturnType<SkillStore["listVerifierQueue"]>>,
): string {
  const pending = queue.filter((s) => s.status === "pending-review");
  if (pending.length === 0) {
    return section("pending", "Pending review", "Awaiting verifier worker.", `<div class="empty">No skills currently pending review.</div>`);
  }
  const rows = pending.map((s) => {
    return `<tr>
      <td>${esc(s.service)}</td>
      <td>${esc(s.version)}</td>
      <td><code>${esc(s.skill_id.slice(0, 10))}…</code></td>
      <td class="num">${s.verifier_succeeded}/2</td>
      <td class="num">${s.consecutive_verifier_failures}/3</td>
      <td>${formatDate(s.created_at)}</td>
    </tr>`;
  });
  return section(
    "pending",
    "Pending review",
    "Awaiting verifier worker (N=2 successful fresh signups to promote; 3 consecutive failures to retire).",
    `<table>
      <thead>
        <tr><th>Service</th><th>Ver.</th><th>ID</th><th>Successes</th><th>Cons. failures</th><th>Created</th></tr>
      </thead>
      <tbody>${rows.join("")}</tbody>
    </table>`,
  );
}

function renderFreshnessSection(
  queue: Awaited<ReturnType<SkillStore["listVerifierQueue"]>>,
): string {
  const due = queue.filter((s) => s.status === "active");
  if (due.length === 0) {
    return section("freshness", "Freshness due", "Active skills whose weekly sweep has elapsed.", `<div class="empty">No active skills are overdue for freshness verification.</div>`);
  }
  const rows = due.map((s) => {
    return `<tr>
      <td>${esc(s.service)}</td>
      <td><code>${esc(s.skill_id.slice(0, 10))}…</code></td>
      <td>${dateOrDash(s.next_freshness_due_at)}</td>
      <td>${dateOrDash(s.last_verified_at)}</td>
      <td class="num">${s.consecutive_verifier_failures}/3</td>
    </tr>`;
  });
  return section(
    "freshness",
    "Freshness due",
    "Active skills whose weekly sweep has elapsed. The verifier worker reruns these to catch service-side regressions.",
    `<table>
      <thead>
        <tr><th>Service</th><th>ID</th><th>Due</th><th>Last verified</th><th>Cons. failures</th></tr>
      </thead>
      <tbody>${rows.join("")}</tbody>
    </table>`,
  );
}

function renderDiscoverySection(
  candidates: Awaited<ReturnType<NonNullable<BotFailureStore>["listDiscoveryCandidates"]>>,
): string {
  if (candidates.length === 0) {
    return section(
      "discovery",
      "Discovery candidates",
      "Services where ≥3 distinct users have hit terminal universal-bot failures in the last 14 days, with no skill in the registry.",
      `<div class="empty">No discovery candidates right now.</div>`,
    );
  }
  const rows = candidates.map((c) => {
    return `<tr>
      <td>${esc(c.service)}</td>
      <td class="num">${c.distinct_failures}</td>
      <td>${esc(c.top_error_kind)}</td>
      <td>${formatDate(c.most_recent_at)}</td>
    </tr>`;
  });
  return section(
    "discovery",
    "Discovery candidates",
    "Services where ≥3 distinct users have hit terminal universal-bot failures in the last 14 days, with no skill in the registry. The discovery worker iterates against these.",
    `<table>
      <thead>
        <tr><th>Service</th><th>Distinct users</th><th>Top failure</th><th>Most recent</th></tr>
      </thead>
      <tbody>${rows.join("")}</tbody>
    </table>`,
  );
}

function renderDemotedSection(
  skills: Awaited<ReturnType<SkillStore["listSkills"]>>,
): string {
  const demoted = skills.filter((s) => s.status === "demoted");
  if (demoted.length === 0) {
    return section("demoted", "Demoted skills", "Auto-demoted on 3 consecutive failures, OR manually demoted by an operator. Use `mcp skill reactivate <id>` to restore.", `<div class="empty">No demoted skills.</div>`);
  }
  const rows = demoted.map((s) => {
    return `<tr>
      <td>${esc(s.service)}</td>
      <td>${esc(s.version)}</td>
      <td><code>${esc(s.skill_id.slice(0, 10))}…</code></td>
      <td class="num">${s.replays_failed}</td>
      <td class="num">${s.consecutive_failures}</td>
      <td>${dateOrDash(s.last_replayed_at)}</td>
    </tr>`;
  });
  return section(
    "demoted",
    "Demoted skills",
    "Auto-demoted on 3 consecutive failures, OR manually demoted by an operator. Use `mcp skill reactivate <id>` to restore.",
    `<table>
      <thead>
        <tr><th>Service</th><th>Ver.</th><th>ID</th><th>Lifetime failures</th><th>Cons. failures</th><th>Last replay</th></tr>
      </thead>
      <tbody>${rows.join("")}</tbody>
    </table>`,
  );
}

function section(id: string, title: string, desc: string, body: string): string {
  return `<section id="${id}">
    <h2>${title}</h2>
    <div class="desc">${desc}</div>
    ${body}
  </section>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function dateOrDash(d: Date | string | null): string {
  if (d === null) return "—";
  return formatDate(d);
}

function formatDate(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().replace("T", " ").slice(0, 16);
}
