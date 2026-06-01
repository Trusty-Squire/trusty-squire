// Operator dashboard — closed-loop strategy Phase 7.
//
// One route, `GET /admin`, returns a server-rendered HTML page with
// five sections:
//   - Active skills (status, replay success, last verified)
//   - Pending review (verifier queue staging)
//   - Freshness due (active skills past their weekly sweep)
//   - Discovery candidates (services with ≥3 user failures, no skill)
//   - Demoted skills (auto-demoted or operator-demoted)
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
import type {
  CacheHitBreakdown,
  DemandRow,
  ProvisionEventRecord,
  ProvisionEventStore,
} from "../provision-event-store.js";
import type {
  ExtractFailureStore,
  ExtractFailureSummary,
} from "../extract-failure-store.js";
import { bearerEquals } from "./admin.js";

export interface AdminDashboardDeps {
  store: SkillStore;
  botFailureStore?: BotFailureStore;
  // T45 — additional stores feeding the "Recent failed attempts"
  // section. Optional so test bootstraps that don't exercise this
  // path can omit them.
  provisionEventStore?: ProvisionEventStore;
  extractFailureStore?: ExtractFailureStore;
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
    const presented = req.query.bearer ?? headerToken ?? "";
    if (!bearerEquals(presented, opts.adminBearer)) {
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

    // T45 — load recent failures (and one slice of per-attempt
    // screenshots each) only when both stores are wired. Older
    // bootstraps that don't pass these get the original 5-section
    // dashboard verbatim.
    const recentFailures: ProvisionEventRecord[] =
      opts.provisionEventStore !== undefined
        ? await opts.provisionEventStore.listRecentFailures(20)
        : [];
    const failureArtifacts = new Map<string, ExtractFailureSummary[]>();
    if (
      opts.extractFailureStore !== undefined &&
      recentFailures.length > 0
    ) {
      for (const attempt of recentFailures) {
        if (attempt.provision_id === null) continue;
        // Hot path is fine here — admin views serve to one operator.
        const snapshots = await opts.extractFailureStore.listByProvisionId(
          attempt.provision_id,
        );
        failureArtifacts.set(attempt.provision_id, snapshots);
      }
    }

    // Panel 2 — cache-hit + demand over a 30-day window. Both null/empty
    // when the event store isn't wired (older bootstraps).
    const WINDOW_MS = 30 * 86_400_000;
    const cacheHit =
      opts.provisionEventStore !== undefined
        ? await opts.provisionEventStore.cacheHitBreakdown(WINDOW_MS)
        : null;
    const demandRows =
      opts.provisionEventStore !== undefined
        ? await opts.provisionEventStore.demandByService(WINDOW_MS, 12)
        : [];
    const activeServiceSet = new Set(activeSkills.map((s) => s.service));

    const html = renderDashboard({
      activeSkills,
      demotedSkills,
      verifierQueue,
      discoveryCandidates,
      recentFailures,
      failureArtifacts,
      cacheHit,
      demandRows,
      activeServiceSet,
    });
    reply.code(200).type("text/html; charset=utf-8").send(html);
  });
};

function renderDashboard(args: {
  activeSkills: Awaited<ReturnType<SkillStore["listSkills"]>>;
  demotedSkills: Awaited<ReturnType<SkillStore["listSkills"]>>;
  verifierQueue: Awaited<ReturnType<SkillStore["listVerifierQueue"]>>;
  discoveryCandidates: Awaited<ReturnType<NonNullable<BotFailureStore>["listDiscoveryCandidates"]>>;
  recentFailures: ProvisionEventRecord[];
  failureArtifacts: Map<string, ExtractFailureSummary[]>;
  cacheHit: CacheHitBreakdown | null;
  demandRows: DemandRow[];
  activeServiceSet: Set<string>;
}): string {
  // Tokens from DESIGN.md (the operator dashboard now follows the
  // product design system: Linear-leaning dark, mono-forward).
  const css = `
    :root {
      --bg:#08080A; --surface:#0E0E11; --raised:#15151A;
      --line:rgba(255,255,255,.06); --line2:rgba(255,255,255,.12);
      --fg:#F4F4F6; --muted:#9A9AA4; --faint:#5A5A63;
      --accent:#8B89FF; --ok:#54D88B; --err:#FF6B6B; --warn:#E0B15A;
      --mono:ui-monospace,"JetBrains Mono","SF Mono",Menlo,monospace;
    }
    body { font: 450 14px/1.55 "Geist",ui-sans-serif,system-ui,sans-serif; max-width: 1080px; margin: 32px auto; padding: 0 16px; color: var(--fg); background: var(--bg); letter-spacing: -0.006em; -webkit-font-smoothing: antialiased; }
    h1 { font-size: 28px; letter-spacing: -0.025em; font-weight: 600; margin-bottom: 4px; }
    .pagesub { color: var(--faint); font-size: 12px; font-family: var(--mono); letter-spacing: .02em; margin-bottom: 28px; }
    .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
    nav { margin: 16px 0 28px; display: flex; gap: 8px; flex-wrap: wrap; }
    nav a { font-size: 12px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; text-decoration: none; color: var(--muted); }
    nav a:hover { border-color: var(--line2); color: var(--fg); }
    section { margin: 28px 0; }
    section h2 { margin: 0 0 4px; font-size: 20px; font-weight: 550; letter-spacing: -0.02em; }
    section .desc { color: var(--muted); font-size: 13px; margin-bottom: 12px; }
    .ruled { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: middle; }
    th { font-weight: 500; color: var(--faint); font-size: 12px; text-transform: lowercase; letter-spacing: .02em; }
    tr:hover td { background: var(--surface); }
    .num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
    .status-active { color: var(--ok); font-weight: 600; }
    .status-pending-review { color: var(--warn); font-weight: 600; }
    .status-demoted { color: var(--err); font-weight: 600; }
    .status-superseded { color: var(--faint); }
    .empty { color: var(--faint); font-style: italic; padding: 16px 12px; }
    code { font-family: var(--mono); font-size: 12px; background: var(--raised); padding: 1px 4px; border-radius: 3px; color: var(--muted); }
    .northstar { border: 1px solid var(--line); border-radius: 10px; padding: 20px; background: var(--surface); }
    .stats { display: flex; gap: 48px; margin-bottom: 20px; flex-wrap: wrap; }
    .stat .k { font-size: 12px; color: var(--faint); }
    .stat .v { font-size: 28px; letter-spacing: -0.02em; font-family: var(--mono); }
    .bar-label { font-size: 13px; color: var(--muted); margin-bottom: 8px; }
    .bar { display: flex; height: 14px; border-radius: 6px; overflow: hidden; border: 1px solid var(--line); }
    .bar .s-replay { background: var(--accent); }
    .bar .s-fell { background: var(--muted); }
    .bar .s-bot { background: var(--raised); }
    .legend { display: flex; gap: 24px; margin-top: 12px; font-size: 12px; flex-wrap: wrap; color: var(--muted); }
    .legend .dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
    .legend .l-replay { background: var(--accent); } .legend .l-fell { background: var(--muted); } .legend .l-bot { background: var(--raised); border: 1px solid var(--line2); }
    .lowN { color: var(--warn); font-family: var(--mono); font-size: 12px; margin-top: 10px; }
    .svc { display: flex; align-items: center; gap: 12px; }
    .tile { width: 28px; height: 28px; border: 1px solid var(--line); border-radius: 6px; display: flex; align-items: center; justify-content: center; font-family: var(--mono); color: var(--muted); font-size: 13px; background: var(--surface); }
    .slug { font-family: var(--mono); }
    .dot-ok { display: inline-block; width: 7px; height: 7px; border-radius: 999px; background: var(--ok); margin-right: 6px; vertical-align: middle; }
    .tag-harvest { font-family: var(--mono); font-size: 11px; color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent); border-radius: 999px; padding: 1px 8px; }
  `;
  const cacheCount = args.cacheHit?.total ?? 0;
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"utf-8\" />",
    "  <title>Trusty Squire — Registry Admin</title>",
    `  <style>${css}${RECENT_FAILURES_CSS}</style>`,
    "</head>",
    "<body>",
    `  <h1>Registry Admin</h1>`,
    `  <div class="pagesub">trusty-squire-registry · operator view · read-only</div>`,
    `  <nav>`,
    `    <a href="#cachehit">Cache hit</a>`,
    `    <a href="#demand">Demand</a>`,
    `    <a href="#active">Active (${args.activeSkills.length})</a>`,
    `    <a href="#pending">Pending review (${args.verifierQueue.filter((s) => s.status === "pending-review").length})</a>`,
    `    <a href="#freshness">Freshness due (${args.verifierQueue.filter((s) => s.status === "active").length})</a>`,
    `    <a href="#discovery">Discovery candidates (${args.discoveryCandidates.length})</a>`,
    `    <a href="#demoted">Demoted (${args.demotedSkills.length})</a>`,
    `    <a href="#failures">Recent failures (${args.recentFailures.length})</a>`,
    `  </nav>`,
    renderCacheHitSection(args.cacheHit),
    renderDemandSection(args.demandRows, args.activeServiceSet),
    renderActiveSection(args.activeSkills),
    renderPendingSection(args.verifierQueue),
    renderFreshnessSection(args.verifierQueue),
    renderDiscoverySection(args.discoveryCandidates),
    renderDemotedSection(args.demotedSkills),
    renderRecentFailuresSection(args.recentFailures, args.failureArtifacts),
    "</body>",
    "</html>",
    `<!-- cacheHit total=${cacheCount} -->`,
  ].join("\n");
}

// Minimum events in the window before cache-hit percentages are
// trustworthy. Below this, the bar is rendered greyed with a caveat.
const CACHE_HIT_MIN_SAMPLE = 50;

function pct(n: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((100 * n) / total).toFixed(1)}%`;
}

function renderCacheHitSection(cacheHit: CacheHitBreakdown | null): string {
  const desc =
    "How often a provision is served from a learned-skill replay vs. the universal bot.";
  if (cacheHit === null || cacheHit.total === 0) {
    return section(
      "cachehit",
      "Cache hit",
      desc,
      `<div class="empty">No provisions recorded yet — the bar appears once events arrive.</div>`,
    );
  }
  const { replay_served, fell_back, no_skill_bot, total } = cacheHit;
  const lowN = total < CACHE_HIT_MIN_SAMPLE;
  const dim = lowN ? ` style="opacity:.5"` : "";
  const body = `<div class="northstar">
      <div class="stats">
        <div class="stat"><div class="k">provisions · 30d</div><div class="v">${total}</div></div>
        <div class="stat"><div class="k">replay-served</div><div class="v" style="color:var(--accent)">${pct(replay_served, total)}</div></div>
        <div class="stat"><div class="k">fell back to bot</div><div class="v">${pct(fell_back, total)}</div></div>
        <div class="stat"><div class="k">no-skill bot</div><div class="v">${pct(no_skill_bot, total)}</div></div>
      </div>
      <div class="bar-label">Dispatch split <span class="mono" style="color:var(--faint)">· N=${total} · last 30d</span></div>
      <div class="bar"${dim}>
        <div class="s-replay" style="width:${(100 * replay_served) / total}%"></div>
        <div class="s-fell" style="width:${(100 * fell_back) / total}%"></div>
        <div class="s-bot" style="width:${(100 * no_skill_bot) / total}%"></div>
      </div>
      <div class="legend">
        <span><span class="dot l-replay"></span>replay-served <span class="mono">${pct(replay_served, total)}</span></span>
        <span><span class="dot l-fell"></span>fell back <span class="mono">${pct(fell_back, total)}</span></span>
        <span><span class="dot l-bot"></span>no-skill bot <span class="mono">${pct(no_skill_bot, total)}</span></span>
      </div>
      ${lowN ? `<div class="lowN">low sample (N=${total}) — percentages are noisy until N ≥ ${CACHE_HIT_MIN_SAMPLE}</div>` : ""}
    </div>`;
  return section("cachehit", "Cache hit", desc, body);
}

function renderDemandSection(demandRows: DemandRow[], activeServiceSet: Set<string>): string {
  const desc =
    "Top services by total provision volume (30d). Amber = high demand, no active skill, not wall-blocked → harvest candidate.";
  if (demandRows.length === 0) {
    return section(
      "demand",
      "Demand distribution",
      desc,
      `<div class="empty">No provision volume recorded yet.</div>`,
    );
  }
  const totalVolume = demandRows.reduce((acc, d) => acc + d.volume, 0);
  const rows = demandRows
    .map((d) => {
      const hasSkill = activeServiceSet.has(d.service);
      const wallRatio = d.failed > 0 ? d.wall_failed / d.failed : 0;
      const harvest = !hasSkill && wallRatio <= 0.5 && d.volume > 0;
      const tile = `<span class="tile">${esc((d.service[0] ?? "?").toUpperCase())}</span>`;
      const skillCell = hasSkill
        ? `<span class="dot-ok"></span><span class="mono" style="color:var(--faint)">active</span>`
        : harvest
          ? `<span class="tag-harvest">harvest candidate</span>`
          : `<span class="mono" style="color:var(--faint)">—</span>`;
      return `<tr>
        <td><div class="svc">${tile}<span class="slug">${esc(d.service)}</span></div></td>
        <td class="num">${d.volume}</td>
        <td class="num">${totalVolume > 0 ? pct(d.volume, totalVolume) : "—"}</td>
        <td>${skillCell}</td>
      </tr>`;
    })
    .join("");
  return section(
    "demand",
    "Demand distribution",
    desc,
    `<div class="ruled"><table>
      <thead><tr><th>service</th><th class="num">provisions</th><th class="num">share</th><th>skill</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`,
  );
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
      <td class="num">${s.verifier_succeeded}/1</td>
      <td class="num">${s.consecutive_verifier_failures}/3</td>
      <td>${formatDate(s.created_at)}</td>
    </tr>`;
  });
  return section(
    "pending",
    "Pending review",
    "Awaiting verifier worker (1 successful fresh signup to promote; 3 consecutive failures to retire).",
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

// T45 — additional CSS for the failures gallery + per-attempt step
// trail. Layered on top of the dashboard's base CSS so the section
// has its own visual density.
const RECENT_FAILURES_CSS = `
  .attempt { border: 1px solid #e5e5ea; border-radius: 6px; padding: 12px; margin-bottom: 12px; background: #fff; }
  .attempt-head { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  .attempt-head .service { font-weight: 600; font-size: 14px; }
  .attempt-head .kind { color: #b3261e; font-family: ui-monospace, monospace; font-size: 12px; }
  .attempt-head .when { color: #6e6e73; font-size: 12px; }
  .attempt-head .pid { color: #6e6e73; font-size: 11px; font-family: ui-monospace, monospace; }
  details.trail { margin-top: 8px; }
  details.trail summary { color: #6e6e73; font-size: 12px; cursor: pointer; }
  details.trail pre { background: #f5f5f7; padding: 8px; border-radius: 4px; max-height: 200px; overflow: auto; white-space: pre-wrap; font-size: 11px; line-height: 1.4; margin: 6px 0 0; }
  .thumbs { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
  .thumbs a { display: block; border: 1px solid #d2d2d7; border-radius: 4px; padding: 4px 8px; font-size: 11px; color: #1d1d1f; text-decoration: none; font-family: ui-monospace, monospace; }
  .thumbs a:hover { background: #f5f5f7; }
`;

function renderRecentFailuresSection(
  failures: readonly ProvisionEventRecord[],
  artifacts: ReadonlyMap<string, ExtractFailureSummary[]>,
): string {
  if (failures.length === 0) {
    return section(
      "failures",
      "Recent failed attempts",
      "Universal-bot signup failures. Linked snapshots (round screenshots, extract failures) are shown when the MCP tagged them with a matching provision_id.",
      `<div class="empty">No failed attempts on record.</div>`,
    );
  }
  const cards = failures
    .map((f) => {
      const snapshots =
        f.provision_id !== null ? artifacts.get(f.provision_id) ?? [] : [];
      const thumbs =
        snapshots.length === 0
          ? `<div class="empty" style="font-size:12px;padding:4px 0;">No screenshot snapshots tagged with this attempt's provision_id.</div>`
          : `<div class="thumbs">${snapshots
              .map(
                (s) =>
                  `<a href="/v1/extract-failures/${esc(s.id)}/jpeg" target="_blank">${esc(s.step_label)} · ${(s.screenshot_bytes / 1024).toFixed(1)}KB</a>`,
              )
              .join("")}</div>`;
      const trail =
        f.step_trail === null || f.step_trail.length === 0
          ? ""
          : `<details class="trail"><summary>Step trail (${f.step_trail.length} chars)</summary><pre>${esc(f.step_trail)}</pre></details>`;
      return `<div class="attempt">
        <div class="attempt-head">
          <span class="service">${esc(f.service)}</span>
          <span class="kind">${esc(f.failure_kind ?? "unknown")}</span>
          <span class="when">${formatDate(f.occurred_at)}</span>
          ${f.provision_id !== null ? `<span class="pid">${esc(f.provision_id)}</span>` : ""}
        </div>
        ${trail}
        ${thumbs}
      </div>`;
    })
    .join("\n");
  return section(
    "failures",
    "Recent failed attempts",
    "Universal-bot signup failures, newest first. Click a snapshot to view the screenshot.",
    cards,
  );
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
