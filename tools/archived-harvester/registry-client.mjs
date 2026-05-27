// Thin registry-API client for harvester-side queries.
//
// Currently only used by daily-digest.mjs to surface pending-review
// skills (the quarantine queue the operator needs to spot-check).
// Phase 3 subagent will reuse this for replay-outcome reporting and
// (probably) for the resume-after-fix-publish check.
//
// All calls are best-effort: network failures return safe fallbacks
// (empty arrays, false) rather than throwing. The harvester is
// resilient to a temporarily-unreachable registry; we never want
// digest emission or a signup attempt to crash because of a registry
// blip.

const DEFAULT_REGISTRY_URL = "https://registry.trustysquire.ai";

function registryBaseUrl(opts = {}) {
  return (
    opts.registryUrl ??
    process.env.TRUSTY_SQUIRE_REGISTRY_URL ??
    DEFAULT_REGISTRY_URL
  );
}

// List skills filtered by status. Returns the skills array (possibly
// empty) on success, [] on any failure.
//
// Valid statuses (as of Phase 2 design):
//   pending-review   — auto-promoted, awaiting operator approval
//   active           — promoted, replayed against new signups
//   demoted          — failed replay 3× consecutively
//   manually-demoted — operator-initiated demote
export async function listSkillsByStatus(status, opts = {}) {
  const base = registryBaseUrl(opts);
  try {
    const url = `${base}/skills?status=${encodeURIComponent(status)}&limit=200`;
    const res = await fetch(url, { signal: opts.signal });
    if (!res.ok) return [];
    const json = await res.json();
    if (!json.ok || !Array.isArray(json.skills)) return [];
    return json.skills;
  } catch {
    return [];
  }
}

// Approve a pending-review skill, flipping it to active. Returns
// true on success, false on any failure. Auth-required in production
// (registry-api gates on SKILL_VERIFY_PUBLIC_KEY) — caller supplies
// the operator's signing key via opts.token or via the
// TRUSTY_SQUIRE_OPERATOR_TOKEN env var if applicable. Phase 2 we
// don't actually call this from the harvester (operator does it
// out-of-band via CLI or curl); the function is here so Phase 3
// can wire it in.
export async function approveSkillReview(skillId, opts = {}) {
  const base = registryBaseUrl(opts);
  try {
    const res = await fetch(`${base}/skills/${encodeURIComponent(skillId)}/approve-review`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify({}),
      signal: opts.signal,
    });
    return res.ok;
  } catch {
    return false;
  }
}
