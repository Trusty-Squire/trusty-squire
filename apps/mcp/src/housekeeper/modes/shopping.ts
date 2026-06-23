import { canonicalizeServiceSlug } from "@trusty-squire/skill-schema";
import type { HousekeeperTask, QueueProvider } from "../queues/index.js";

export type ShoppingStatus = "verified" | "bad" | "blocked";
export type ShoppingEntryKind =
  | "oauth_signup"
  | "signup_form"
  | "login_with_signup_toggle"
  | "trial_signup"
  | "unknown";

export interface ShoppingInput {
  service: string;
  signupUrl?: string;
}

export interface ShoppingCandidate {
  url: string;
  sourceUrl: string;
  sourceType: "curated" | "homepage_cta" | "guessed_homepage";
  anchorText: string;
}

export interface ShoppingEvidence {
  sourceUrl: string;
  anchorText: string;
  httpStatus: number;
  finalUrl: string;
  pageSignals: string[];
  sourceType: ShoppingCandidate["sourceType"];
}

export interface ShoppingResult {
  service: string;
  status: ShoppingStatus;
  signupUrl: string | null;
  finalUrl: string | null;
  entryKind: ShoppingEntryKind;
  confidence: number;
  reason: string;
  evidence: ShoppingEvidence[];
  rejected: Array<{ url: string; reason: string }>;
}

export interface ShoppingConfig {
  fetchFn?: typeof globalThis.fetch;
  log?: (line: string) => void;
  maxCandidatesPerService?: number;
}

const SIGNUP_CTA_TEXT =
  /\b(?:sign\s*up|signup|create\s+(?:an?\s+)?account|get\s*started|start\s+free|try\s+free|register|join\s+free|continue\s+with\s+(?:google|github))\b/i;
const SIGNUP_PATH =
  /\/(?:sign[_-]?up|signup|register|join|start|auth\/(?:sign[_-]?up|signup|register)|users\/sign[_-]?up)(?:[/?#]|$)/i;
const LOGIN_PATH = /\/(?:login|log[_-]?in|signin|sign[_-]?in|auth)(?:[/?#]|$)/i;
const BAD_PAGE_TEXT =
  /\b(?:page not found|404|not found|does not exist|contact sales|talk to sales|request demo|join (?:the )?waitlist|invite only|invitation only)\b/i;
const SIGNUP_PAGE_TEXT =
  /\b(?:sign\s*up|create\s+(?:an?\s+)?account|register|get\s*started|start\s+free|try\s+free|continue\s+with\s+google|continue\s+with\s+github|sign\s+in\s+with\s+google|sign\s+in\s+with\s+github)\b/i;
const LOGIN_TEXT = /\b(?:log\s*in|sign\s*in)\b/i;
const EMAIL_FIELD = /\b(?:email address|work email|business email|type=["']email["'])\b/i;
const PASSWORD_FIELD = /\b(?:password|type=["']password["'])\b/i;

function stripTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function serviceHomepageCandidates(service: string): string[] {
  const slug = canonicalizeServiceSlug(service);
  return [`https://${slug}.com`, `https://www.${slug}.com`];
}

function normalizeCandidateUrl(raw: string, sourceUrl: string): string | null {
  const trimmed = decodeHtml(raw).trim();
  if (trimmed.length === 0 || trimmed === "#" || trimmed.startsWith("#")) return null;
  if (/^(?:javascript:|mailto:|tel:)/i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed, sourceUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

export function extractSignupCandidates(input: {
  sourceUrl: string;
  html: string;
  sourceType?: ShoppingCandidate["sourceType"];
}): ShoppingCandidate[] {
  const out: ShoppingCandidate[] = [];
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of input.html.matchAll(anchorRe)) {
    const href = match[1] ?? "";
    const text = stripTags(match[2] ?? "");
    const url = normalizeCandidateUrl(href, input.sourceUrl);
    if (url === null) continue;
    if (!SIGNUP_CTA_TEXT.test(text) && !SIGNUP_PATH.test(url)) continue;
    out.push({
      url,
      sourceUrl: input.sourceUrl,
      sourceType: input.sourceType ?? "homepage_cta",
      anchorText: text.length > 0 ? text : href,
    });
  }
  return dedupeCandidates(out);
}

function dedupeCandidates(candidates: readonly ShoppingCandidate[]): ShoppingCandidate[] {
  const byUrl = new Map<string, ShoppingCandidate>();
  for (const candidate of candidates) {
    if (!byUrl.has(candidate.url)) byUrl.set(candidate.url, candidate);
  }
  return [...byUrl.values()];
}

function pageSignals(html: string, finalUrl: string): string[] {
  const text = stripTags(html);
  const signals: string[] = [];
  if (SIGNUP_PATH.test(finalUrl)) signals.push("signup_url_path");
  if (LOGIN_PATH.test(finalUrl)) signals.push("login_url_path");
  if (/\bcontinue\s+with\s+google\b/i.test(text)) signals.push("continue_with_google");
  if (/\bcontinue\s+with\s+github\b/i.test(text)) signals.push("continue_with_github");
  if (/\bsign\s+in\s+with\s+google\b/i.test(text)) signals.push("sign_in_with_google");
  if (/\bsign\s+in\s+with\s+github\b/i.test(text)) signals.push("sign_in_with_github");
  if (SIGNUP_PAGE_TEXT.test(text)) signals.push("signup_copy");
  if (LOGIN_TEXT.test(text)) signals.push("login_copy");
  if (EMAIL_FIELD.test(html) || EMAIL_FIELD.test(text)) signals.push("email_field");
  if (PASSWORD_FIELD.test(html) || PASSWORD_FIELD.test(text)) signals.push("password_field");
  if (/\b(?:trial|free trial|start free|try free)\b/i.test(text)) signals.push("trial_copy");
  if (BAD_PAGE_TEXT.test(text)) signals.push("bad_or_blocked_copy");
  return [...new Set(signals)];
}

function classifyEntryKind(signals: readonly string[]): ShoppingEntryKind {
  if (
    signals.includes("continue_with_google") ||
    signals.includes("continue_with_github") ||
    signals.includes("sign_in_with_google") ||
    signals.includes("sign_in_with_github")
  ) {
    return "oauth_signup";
  }
  if (signals.includes("trial_copy") && signals.includes("signup_copy")) return "trial_signup";
  if (
    signals.includes("login_copy") &&
    (signals.includes("signup_copy") || signals.includes("signup_url_path"))
  ) {
    return "login_with_signup_toggle";
  }
  if (signals.includes("email_field") && signals.includes("password_field")) return "signup_form";
  if (signals.includes("signup_copy") || signals.includes("signup_url_path")) return "signup_form";
  return "unknown";
}

function confidenceFor(input: {
  candidate: ShoppingCandidate;
  status: ShoppingStatus;
  entryKind: ShoppingEntryKind;
  signals: readonly string[];
}): number {
  if (input.status !== "verified") return 0;
  let score = input.candidate.sourceType === "curated" ? 0.72 : 0.58;
  if (input.candidate.sourceType === "homepage_cta") score += 0.12;
  if (input.signals.includes("signup_url_path")) score += 0.08;
  if (input.entryKind === "oauth_signup") score += 0.1;
  if (input.entryKind === "signup_form" || input.entryKind === "trial_signup") score += 0.07;
  return Math.min(0.97, Number(score.toFixed(2)));
}

export async function verifySignupCandidate(
  candidate: ShoppingCandidate,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<ShoppingResult> {
  let res: Response;
  try {
    res = await fetchFn(candidate.url, {
      redirect: "follow",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "trusty-squire-housekeeper-shopping/1.0",
      },
    });
  } catch (err) {
    return {
      service: "",
      status: "bad",
      signupUrl: null,
      finalUrl: null,
      entryKind: "unknown",
      confidence: 0,
      reason: `fetch_failed: ${err instanceof Error ? err.message : String(err)}`,
      evidence: [],
      rejected: [{ url: candidate.url, reason: "fetch_failed" }],
    };
  }

  const html = await res.text().catch(() => "");
  const finalUrl = res.url || candidate.url;
  const signals = pageSignals(html, finalUrl);
  const entryKind = classifyEntryKind(signals);
  const evidence: ShoppingEvidence = {
    sourceUrl: candidate.sourceUrl,
    anchorText: candidate.anchorText,
    httpStatus: res.status,
    finalUrl,
    pageSignals: signals,
    sourceType: candidate.sourceType,
  };

  if (res.status === 404 || res.status === 410) {
    return {
      service: "",
      status: "bad",
      signupUrl: null,
      finalUrl,
      entryKind,
      confidence: 0,
      reason: `http_${res.status}`,
      evidence: [evidence],
      rejected: [{ url: candidate.url, reason: `http_${res.status}` }],
    };
  }
  if (res.status >= 400) {
    return {
      service: "",
      status: "bad",
      signupUrl: null,
      finalUrl,
      entryKind,
      confidence: 0,
      reason: `http_${res.status}`,
      evidence: [evidence],
      rejected: [{ url: candidate.url, reason: `http_${res.status}` }],
    };
  }
  const hasConcreteSignupControl =
    signals.includes("continue_with_google") ||
    signals.includes("continue_with_github") ||
    signals.includes("sign_in_with_google") ||
    signals.includes("sign_in_with_github") ||
    signals.includes("email_field") ||
    signals.includes("password_field");
  if (signals.includes("bad_or_blocked_copy") && !hasConcreteSignupControl) {
    return {
      service: "",
      status: "blocked",
      signupUrl: null,
      finalUrl,
      entryKind,
      confidence: 0,
      reason: "blocked_or_non_self_serve",
      evidence: [evidence],
      rejected: [{ url: candidate.url, reason: "blocked_or_non_self_serve" }],
    };
  }
  if (entryKind === "unknown") {
    return {
      service: "",
      status: "bad",
      signupUrl: null,
      finalUrl,
      entryKind,
      confidence: 0,
      reason: "no_signup_signals",
      evidence: [evidence],
      rejected: [{ url: candidate.url, reason: "no_signup_signals" }],
    };
  }

  return {
    service: "",
    status: "verified",
    signupUrl: candidate.url,
    finalUrl,
    entryKind,
    confidence: confidenceFor({ candidate, status: "verified", entryKind, signals }),
    reason: "verified_signup_entrypoint",
    evidence: [evidence],
    rejected: [],
  };
}

async function fetchHtml(
  url: string,
  fetchFn: typeof globalThis.fetch,
): Promise<string | null> {
  try {
    const res = await fetchFn(url, {
      redirect: "follow",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "trusty-squire-housekeeper-shopping/1.0",
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function runShoppingForService(
  input: ShoppingInput,
  config: ShoppingConfig = {},
): Promise<ShoppingResult> {
  const service = canonicalizeServiceSlug(input.service);
  const fetchFn = config.fetchFn ?? globalThis.fetch;
  const log = config.log ?? (() => {});
  const maxCandidates = config.maxCandidatesPerService ?? 8;
  const candidates: ShoppingCandidate[] = [];
  if (input.signupUrl !== undefined && input.signupUrl.length > 0) {
    candidates.push({
      url: input.signupUrl,
      sourceUrl: input.signupUrl,
      sourceType: "curated",
      anchorText: "curated signup_url",
    });
  }

  for (const homepage of serviceHomepageCandidates(service)) {
    const html = await fetchHtml(homepage, fetchFn);
    if (html === null) continue;
    candidates.push(...extractSignupCandidates({ sourceUrl: homepage, html }));
  }

  if (candidates.length === 0) {
    for (const homepage of serviceHomepageCandidates(service)) {
      candidates.push({
        url: homepage,
        sourceUrl: homepage,
        sourceType: "guessed_homepage",
        anchorText: "homepage fallback",
      });
    }
  }

  const rejected: ShoppingResult["rejected"] = [];
  const evidence: ShoppingEvidence[] = [];
  const checked = dedupeCandidates(candidates).slice(0, maxCandidates);
  log(`[shopping] ${service}: checking ${checked.length} candidate(s)`);
  for (const candidate of checked) {
    const result = await verifySignupCandidate(candidate, fetchFn);
    evidence.push(...result.evidence);
    rejected.push(...result.rejected);
    if (result.status === "verified") {
      return {
        ...result,
        service,
        rejected,
        evidence,
      };
    }
  }

  const blocked = rejected.some((r) => r.reason === "blocked_or_non_self_serve");
  return {
    service,
    status: blocked ? "blocked" : "bad",
    signupUrl: null,
    finalUrl: evidence.at(-1)?.finalUrl ?? null,
    entryKind: "unknown",
    confidence: 0,
    reason: blocked ? "blocked_or_non_self_serve" : "no_verified_signup_entrypoint",
    evidence,
    rejected,
  };
}

export interface RunShoppingBatchResult {
  attempted: number;
  verified: number;
  bad: number;
  blocked: number;
  results: ShoppingResult[];
}

export async function runShoppingBatch(input: {
  queue: QueueProvider;
  limit?: number;
  config?: ShoppingConfig;
}): Promise<RunShoppingBatchResult> {
  const tasks = await input.queue.fetch(input.limit ?? 20);
  const results: ShoppingResult[] = [];
  for (const task of tasks) {
    if (task.kind !== "discover") continue;
    results.push(await runShoppingForService(taskToShoppingInput(task), input.config));
  }
  return {
    attempted: results.length,
    verified: results.filter((r) => r.status === "verified").length,
    bad: results.filter((r) => r.status === "bad").length,
    blocked: results.filter((r) => r.status === "blocked").length,
    results,
  };
}

function taskToShoppingInput(task: Extract<HousekeeperTask, { kind: "discover" }>): ShoppingInput {
  return {
    service: task.service,
    ...(task.signupUrl !== undefined ? { signupUrl: task.signupUrl } : {}),
  };
}
