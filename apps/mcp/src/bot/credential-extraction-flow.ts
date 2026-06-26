// CredentialExtractionFlow owns the policy boundary between "values the
// extractor happened to carry around" and "usable service credentials".
//
// The heavy extraction mechanics still live in agent.ts/extraction.ts for now;
// this module is intentionally the small, shared contract the orchestration
// loop uses to decide whether to continue navigating, wait for sibling fields,
// or return a successful bundle.

// Keys that the post-signup accumulator stores for housekeeping. They are not
// extracted credentials and must not count as progress or success.
export const NON_CREDENTIAL_KEYS = new Set<string>([
  "api_key_truncated",
  "password",
  "email",
]);

export function credentialFieldNames(
  creds: Record<string, string | undefined>,
): string[] {
  return Object.entries(creds)
    .filter(([, value]) => value !== undefined && value.length > 0)
    .map(([key]) => key)
    .filter((key) => !NON_CREDENTIAL_KEYS.has(key));
}

// Credential fields that are usable by themselves. Other named fields can be
// part of a credential bundle, but a lone identifier such as cloud_name,
// application_id, client_id, or org_id must not end the post-signup loop.
// personal_api_key / project_api_key are full single-use secrets in their own
// right (MEASURED 2026-06-24: posthog mints a personal_api_key `phx_…` — a
// complete credential — but the loop bailed oauth_onboarding_failed because the
// lone field wasn't single-sufficient and 1 < 2 failed the bundle fallback).
export const SINGLE_CREDENTIAL_FIELDS = new Set<string>([
  "api_key",
  "personal_api_key",
  "project_api_key",
  "username",
  "access_token",
  "auth_token",
  "api_secret",
  "secret_key",
  "secret",
  "token",
]);

const SECRET_LIKE_SINGLE_FIELDS = new Set<string>([
  "api_key",
  "personal_api_key",
  "project_api_key",
  "access_token",
  "auth_token",
  "api_secret",
  "secret_key",
  "secret",
  "token",
]);

const CREDENTIAL_PREFIX_RE =
  /^(?:sk|pk|rk|phx|phc|gh[pousr]?|glpat|xox[baprs]|AIza|AKIA|ASIA|eyJ|ddp|tkn|tok|key|api)[A-Za-z0-9_.+/=-]*$/;

export function isPlausibleCredentialValue(
  key: string,
  value: string | undefined,
): boolean {
  if (value === undefined) return false;
  const v = value.trim();
  if (v.length === 0) return false;
  if (/\s/.test(v)) return false;
  if (/[,"'<>]/.test(v)) return false;
  if (/^[A-Za-z]+[.,:;!?-]?$/.test(v)) return false;
  if (/^[^A-Za-z0-9]+$/.test(v)) return false;
  if (/^[^@]+@[^@]+\.[^@]+$/.test(v)) return false;

  if (!SECRET_LIKE_SINGLE_FIELDS.has(key)) return true;
  if (v.length < 8) return false;
  if (CREDENTIAL_PREFIX_RE.test(v)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true;
  if (/[A-Za-z]/.test(v) && /[0-9]/.test(v) && v.length >= 12) return true;
  return /[_-]/.test(v) && v.length >= 16;
}

export function hasSingleCredentialValue(
  creds: Record<string, string | undefined>,
): boolean {
  return Object.entries(creds).some(
    ([key, value]) =>
      SINGLE_CREDENTIAL_FIELDS.has(key) &&
      isPlausibleCredentialValue(key, value),
  );
}

// True iff the credentials Record holds at least one extracted value
// (api_key, username, or any labeled multi-cred field). Excludes metadata and
// truncated stubs. Used to decide whether an extraction round produced progress.
export function hasAnyExtractedCredential(
  creds: Record<string, string | undefined>,
): boolean {
  return credentialFieldNames(creds).length > 0;
}

// True iff the credentials Record contains a multi-credential bundle: anything
// beyond the legacy single api_key/username shape. This keeps multi-field
// services open long enough to collect sibling secrets.
export function isMultiCredBundle(
  creds: Record<string, string | undefined>,
): boolean {
  return credentialFieldNames(creds).some(
    (key) => !SINGLE_CREDENTIAL_FIELDS.has(key),
  );
}

// Final success policy for the signup result. Legacy single-key services can
// return on api_key; services with no literal api_key need at least two named
// non-metadata fields so a lone application/project ID does not masquerade as a
// usable secret.
export function hasUsableCredentialBundle(
  creds: Record<string, string | undefined>,
): boolean {
  if (hasSingleCredentialValue(creds)) return true;
  return credentialFieldNames(creds).length >= 2;
}

// A terminal planner "done" reason can carry stronger evidence than an earlier
// regex hit. If the visible page only exposes an identifier while the actual
// secret is masked/unrecoverable, the earlier candidate is usually a key id,
// project id, or rotation handle, not a usable credential.
export function terminalReasonInvalidatesCredentialSuccess(
  reason: string | null | undefined,
): boolean {
  if (reason === null || reason === undefined || reason.trim().length === 0) {
    return false;
  }
  const text = reason.toLowerCase();
  const namesSecret =
    /\b(?:api\s*)?(?:key|token|secret)\b/.test(text) ||
    /\b(?:credential|value)\b/.test(text);
  if (!namesSecret) return false;

  if (
    /\bkey\s*id\b/.test(text) &&
    /\b(?:visible|shown|available)\b/.test(text) &&
    /\b(?:not\s+the\s+secret|secret\s+(?:is\s+)?(?:masked|hidden|not\s+(?:visible|shown|available|recoverable)))\b/.test(text)
  ) {
    return true;
  }

  if (
    /\b(?:no|not any|without)\s+(?:option|button|way|ability|path)\s+to\s+(?:reveal|view|show|copy|extract|recover)\b/.test(text) &&
    /\b(?:masked|hidden|unrecoverable|not\s+(?:recoverable|available|shown|visible)|only\s+to\s+rotate|rotate)\b/.test(text)
  ) {
    return true;
  }

  return /\bonly\s+to\s+rotate\b/.test(text) && /\b(?:masked|hidden|secret)\b/.test(text);
}

// Phase E — multi-credential planner-prose parser. When a service
// exposes several distinct credentials on the same page (Cloudinary:
// cloud_name + api_key + api_secret; Algolia: application_id +
// admin_api_key + search_api_key; Twilio: account_sid + auth_token;
// Stripe: publishable_key + secret_key), the post-verify planner is
// instructed (Phase E prompt update) to label each value explicitly
// in its extract reason. This parser pulls those labels + values out
// and returns them as { [label]: value }.
//
// The label vocabulary is whitelisted to known credential-shaped
// names so the parser doesn't false-match prose like "the
// dashboard_url is …" or "the project_name is …". Anything outside
// the whitelist is dropped to keep credentials objects clean.
//
// Returns empty record when nothing parsed. Caller folds the result
// into the credentials dict; falls back to single-cred extraction
// when this returns empty.
export function extractAllLabeledTokensFromReason(
  reason: string,
  pageText: string,
): Record<string, string> {
  // Whitelist of credential labels we recognize. Snake_case canonical;
  // the matcher tolerates the LLM emitting hyphenated or PascalCase
  // variants. Each entry maps a normalized form back to the canonical
  // snake_case used in the credentials Record.
  const LABEL_ALIASES: Record<string, string> = {
    api_key: "api_key",
    apikey: "api_key",
    api_token: "api_key",
    apitoken: "api_key",
    access_token: "access_token",
    accesstoken: "access_token",
    api_secret: "api_secret",
    apisecret: "api_secret",
    secret_key: "secret_key",
    secretkey: "secret_key",
    publishable_key: "publishable_key",
    publishablekey: "publishable_key",
    client_id: "client_id",
    clientid: "client_id",
    client_secret: "client_secret",
    clientsecret: "client_secret",
    cloud_name: "cloud_name",
    cloudname: "cloud_name",
    application_id: "application_id",
    applicationid: "application_id",
    app_id: "application_id",
    appid: "application_id",
    admin_api_key: "admin_api_key",
    adminapikey: "admin_api_key",
    search_api_key: "search_api_key",
    searchapikey: "search_api_key",
    monitoring_api_key: "monitoring_api_key",
    account_sid: "account_sid",
    accountsid: "account_sid",
    auth_token: "auth_token",
    authtoken: "auth_token",
    sandbox_secret: "sandbox_secret",
    sandboxsecret: "sandbox_secret",
    org_id: "org_id",
    orgid: "org_id",
    organization_id: "org_id",
    consumer_key: "consumer_key",
    consumer_secret: "consumer_secret",
    access_token_secret: "access_token_secret",
    project_api_key: "project_api_key",
    personal_api_key: "api_key",
    app_key: "app_key",
    appkey: "app_key",
    app_secret: "app_secret",
    appsecret: "app_secret",
    // 2026-06-08 — bare "secret" (Pusher's App Keys page labels its app
    // secret just "secret"; the bot reached the keys page + saw it but the
    // parser dropped it because no alias mapped bare "secret"). Maps to a
    // neutral `secret` credential name. The \bsecret\b match can't fire
    // inside api_secret/client_secret/app_secret (the preceding "_" kills
    // the word boundary), so this doesn't double-capture those.
    secret: "secret",
    // 0.8.3-rc.1 — typeform's planner uses `personal_access_token`
    // and `Personal access token` (the latter when transcribing the
    // page heading verbatim). Both alias to api_key — typeform issues
    // ONE token type, and downstream consumers expect `api_key`.
    personal_access_token: "api_key",
    personalaccesstoken: "api_key",
    // Bearer / private / write key patterns surfaced across the
    // 2026-05-29 retest. Each was quoted by the planner but not in
    // the alias set, so the labeled extractor missed them.
    bearer_token: "api_key",
    bearertoken: "api_key",
    private_key: "api_key",
    privatekey: "api_key",
    write_key: "api_key",
    writekey: "api_key",
    read_key: "api_key",
    readkey: "api_key",
    server_token: "api_key",
    servertoken: "api_key",
  };

  const out: Record<string, string> = {};

  // Build the label-alternation from the whitelist keys. Restricting
  // the regex to KNOWN labels avoids the greedy-match-eats-real-label
  // bug (without this, "shows: application_id" would match as
  // label='shows' / value='application_id' and consume the real
  // 'application_id' that follows). Longer aliases first so the
  // regex prefers `admin_api_key` over `api_key` at the same start.
  const labelKeys = Object.keys(LABEL_ALIASES).sort(
    (a, b) => b.length - a.length,
  );
  const labelAlt = labelKeys.map(escapeRegex).join("|");
  // Hyphen + space variants — the LLM sometimes emits `cloud-name`
  // or `Cloud name` instead of `cloud_name`. Replace _ with
  // [-_\s] inside each alternative so the regex matches all three.
  const labelAltLoose = labelAlt.replace(/_/g, "[-_\\s]");
  // Two patterns:
  //
  // (A) Strict QUOTED form — `label='value'` / `label="value"` /
  //     `label:'value'` etc. Trusts the value as credential-shape
  //     because the planner was instructed (Phase E prompt) to quote.
  //
  // (B) Prose `label is value` form — required for natural-language
  //     extracts but DANGEROUS. The Cloudinary trace produced
  //     "api_secret is hidden behind asterisks" — the prose-pattern
  //     greedily captured `hidden` as the value, then the
  //     anti-hallucination check passed (the word "hidden" was in
  //     pageText/reason). Mitigations: (1) require the value to LOOK
  //     credential-shape (mixed alpha+digit, ≥16 chars, OR a known
  //     credential prefix); (2) hard-reject a curated set of common
  //     English status words that look label-like in extract prose.
  const quotedRe = new RegExp(
    `\\b(${labelAltLoose})\\b\\s*[=:]\\s*['"\`]([A-Za-z0-9_.+/=\\-]{4,80})['"\`]`,
    "gi",
  );
  for (const m of reason.matchAll(quotedRe)) {
    const rawLabel = (m[1] ?? "").toLowerCase().replace(/[-\s]+/g, "_");
    const normalized = rawLabel.replace(/_+/g, "_");
    const canonical = LABEL_ALIASES[normalized];
    const value = m[2];
    if (canonical === undefined || value === undefined) continue;
    // Email local-part guard. The value class stops at '@', so an email
    // ("giselle703@gmail.com") is captured as its local-part ("giselle703")
    // — a digit-bearing string that passes credential-shape. An email is
    // never a credential; reject when the captured value is immediately
    // followed by '@' in the source. (Cloudinary email-settings page.)
    if (reason.includes(value + "@") || pageText.includes(value + "@")) continue;
    if (!pageText.includes(value)) continue;
    if (out[canonical] === undefined) out[canonical] = value;
  }

  // English status words that show up in planner prose alongside
  // a credential label but are NEVER the credential value itself.
  // Each is a literal lowercase comparison after value-lowercase.
  const PROSE_BLACKLIST = new Set<string>([
    "hidden", "masked", "shown", "visible", "available", "missing",
    "unavailable", "redacted", "obscured", "concealed", "secret",
    "true", "false", "null", "none", "empty", "unset", "undefined",
    "displayed", "revealed", "asterisks", "bullets", "dots", "stars",
    "blurred", "encrypted",
  ]);
  const looksCredentialShape = (v: string): boolean => {
    if (v.length >= 16) return true; // long-enough tokens are presumed real
    if (/^[A-Za-z]+$/.test(v)) return false; // pure word → suspect
    if (/^\d{10,}$/.test(v)) return true; // long all-digit (Cloudinary api_key)
    if (/[_\-]/.test(v) && /[a-z]/i.test(v) && /\d/.test(v)) return true; // mixed
    if (/^[a-z]+_[A-Za-z0-9]/i.test(v)) return true; // prefix_ style (sk_…, npm_…)
    if (/\d/.test(v) && /[A-Za-z]/.test(v)) return true; // alphanumeric mix
    return false; // pure short word → reject as suspect
  };
  // Same separator vocab as quoted, plus optional quotes around the
  // value. The credential-shape + blacklist guards run on the
  // captured (possibly-unquoted) value.
  const proseRe = new RegExp(
    `\\b(${labelAltLoose})\\b\\s*(?:[=:]|\\b(?:is|are)\\b)\\s*['"\`]?([A-Za-z0-9_.+/=\\-]{4,80})['"\`]?`,
    "gi",
  );
  for (const m of reason.matchAll(proseRe)) {
    const rawLabel = (m[1] ?? "").toLowerCase().replace(/[-\s]+/g, "_");
    const normalized = rawLabel.replace(/_+/g, "_");
    const canonical = LABEL_ALIASES[normalized];
    const value = m[2];
    if (canonical === undefined || value === undefined) continue;
    if (out[canonical] !== undefined) continue; // quoted-form already won
    if (PROSE_BLACKLIST.has(value.toLowerCase())) continue;
    // Email local-part guard — see the quoted loop above.
    if (reason.includes(value + "@") || pageText.includes(value + "@")) continue;
    if (!looksCredentialShape(value)) continue;
    if (!pageText.includes(value)) continue;
    out[canonical] = value;
  }

  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// DOM-label phrase → canonical credential key. Shared by
// extractFromDomProximity (which harvests VALUES) and
// countPresentedCredentialLabels (which counts how many distinct
// credentials a page PRESENTS, masked included). Kept in lockstep with
// the Phase E LABEL_ALIASES vocabulary.
export const DOM_LABEL_TO_KEY: Record<string, string> = {
  "api key": "api_key",
  "api token": "api_key",
  "api secret": "api_secret",
  "secret key": "secret_key",
  "publishable key": "publishable_key",
  "access key": "access_key_id",
  "access key id": "access_key_id",
  "access token": "access_token",
  "bearer token": "access_token",
  "personal access token": "api_key",
  "auth token": "auth_token",
  "client id": "client_id",
  "client secret": "client_secret",
  "client key": "client_id",
  "cloud name": "cloud_name",
  cloudname: "cloud_name",
  "application id": "application_id",
  "app id": "application_id",
  "admin api key": "admin_api_key",
  "search api key": "search_api_key",
  "search-only api key": "search_api_key",
  "monitoring api key": "monitoring_api_key",
  "account sid": "account_sid",
  "secret access key": "secret_access_key",
  "consumer key": "consumer_key",
  "consumer secret": "consumer_secret",
  "access token secret": "access_token_secret",
  "project api key": "project_api_key",
  "personal api key": "api_key",
  "organization id": "org_id",
  "org id": "org_id",
  "app key": "app_key",
  "app secret": "app_secret",
};


export interface LabeledCredentialCandidate {
  value: string;
  label: string | null;
  isMasked: boolean;
}

export interface CredentialRevealResult {
  clicked: number;
  diagnostic: string[];
}

export interface PostSignupExtractionRoundPort {
  extractText(): Promise<string>;
  extractAllInputValues(): Promise<string[]>;
  extractCredentials(): Promise<Record<string, string>>;
  extractFromDomProximity(): Promise<Record<string, string>>;
  revealMaskedCredentials(): Promise<CredentialRevealResult>;
  extractLabeledCredentialCandidates(): Promise<LabeledCredentialCandidate[]>;
  countPresentedCredentialLabels(): Promise<number>;
}

export interface PostSignupExtractionRoundInput {
  credentials: Record<string, string>;
  reason: string;
  round: number;
  maxRounds: number;
  detectPresentedCredentialLabels: boolean;
  port: PostSignupExtractionRoundPort;
}

export interface PostSignupExtractionRoundResult {
  foundAnyCredential: boolean;
  presentedCredentialCount: number | null;
  verifySource: string;
  steps: string[];
}

export interface PostClickCredentialPollPort {
  wait(seconds: number): Promise<void>;
  captureTransientAlert(timeoutSeconds: number): Promise<string>;
  extractCredentials(): Promise<Record<string, string>>;
  extractFromDomProximity(): Promise<Record<string, string>>;
}

export interface PostClickCredentialPollInput {
  credentials: Record<string, string>;
  port: PostClickCredentialPollPort;
  maxWaitMs?: number;
  pollIntervalSeconds?: number;
  maxPolls?: number;
}

export interface PostClickCredentialPollResult {
  alertSeen: string;
  foundApiKey: boolean;
}

export class CredentialExtractionFlow {
  hasAnyExtractedCredential(
    creds: Record<string, string | undefined>,
  ): boolean {
    return hasAnyExtractedCredential(creds);
  }

  isMultiCredBundle(creds: Record<string, string | undefined>): boolean {
    return isMultiCredBundle(creds);
  }

  hasUsableCredentialBundle(
    creds: Record<string, string | undefined>,
  ): boolean {
    return hasUsableCredentialBundle(creds);
  }

  async runPostSignupExtractionRound(
    input: PostSignupExtractionRoundInput,
  ): Promise<PostSignupExtractionRoundResult> {
    const steps: string[] = [];
    const roundLabel = `Post-verify ${input.round + 1}/${input.maxRounds}`;
    const { credentials, port } = input;

    const [pageText, inputValues] = await Promise.all([
      port.extractText().catch(() => ""),
      port.extractAllInputValues().catch(() => [] as string[]),
    ]);
    const verifySource = pageText + "\n" + inputValues.join("\n");

    const legacy = await port.extractCredentials();
    mergeFirstWins(credentials, legacy);

    const labeled = extractAllLabeledTokensFromReason(
      input.reason,
      verifySource,
    );
    const labeledNewKeys = mergeFirstWins(credentials, labeled);
    if (labeledNewKeys.length > 0) {
      const summary = labeledNewKeys
        .map((key) => summarizeCredential(key, labeled[key]!))
        .join(", ");
      steps.push(
        `${roundLabel}: Phase E surfaced ${labeledNewKeys.length} labeled credential(s) (${summary})`,
      );
    }

    const MASKED_HINT =
      /\b(?:masked|hidden|bullets?|asterisks?|••+|\*{3,}|reveal|unmask)\b/i;
    if (MASKED_HINT.test(input.reason)) {
      try {
        const revealRes = await port.revealMaskedCredentials();
        steps.push(
          `${roundLabel}: reveal pass clicked=${revealRes.clicked} diagnostic=[${revealRes.diagnostic.join("; ")}]`,
        );
        if (revealRes.clicked > 0) {
          const labeledAfter = await port.extractFromDomProximity();
          const afterNewKeys = mergeFirstWins(credentials, labeledAfter);
          if (afterNewKeys.length > 0) {
            steps.push(
              `${roundLabel}: post-reveal DOM-proximity extracted ${afterNewKeys.length} more (${afterNewKeys.join(", ")})`,
            );
          } else {
            const allLabeled = await port.extractLabeledCredentialCandidates();
            const candSummary = allLabeled
              .filter((candidate) => !candidate.isMasked)
              .slice(0, 8)
              .map(
                (candidate) =>
                  `${candidate.value.slice(0, 6)}…(${candidate.value.length}ch)/${candidate.label ?? "no-label"}`,
              )
              .join(", ");
            steps.push(
              `${roundLabel}: post-reveal had ${allLabeled.length} candidates; visible: ${candSummary}`,
            );
          }
        }
      } catch (err) {
        steps.push(
          `${roundLabel}: reveal pass error (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }

    try {
      const labeledFromDom = await port.extractFromDomProximity();
      const domNewKeys = mergeFirstWins(credentials, labeledFromDom);
      if (domNewKeys.length > 0) {
        const summary = domNewKeys
          .map((key) => summarizeCredential(key, labeledFromDom[key]!))
          .join(", ");
        steps.push(
          `${roundLabel}: DOM-proximity surfaced ${domNewKeys.length} more (${summary})`,
        );
      }
    } catch {
      // DOM-proximity is best-effort; a page mid-navigation should not abort
      // the extraction round.
    }

    let presentedCredentialCount: number | null = null;
    if (input.detectPresentedCredentialLabels) {
      presentedCredentialCount = await port.countPresentedCredentialLabels();
    }

    return {
      foundAnyCredential: hasAnyExtractedCredential(credentials),
      presentedCredentialCount,
      verifySource,
      steps,
    };
  }

  async pollAfterCredentialProducingClick(
    input: PostClickCredentialPollInput,
  ): Promise<PostClickCredentialPollResult> {
    const maxWaitMs = input.maxWaitMs ?? 8000;
    const pollIntervalSeconds = input.pollIntervalSeconds ?? 0.5;
    const maxPolls = input.maxPolls ?? Number.POSITIVE_INFINITY;
    const deadline = Date.now() + maxWaitMs;
    let alertSeen = "";
    let alertChecked = false;
    let polls = 0;

    while (Date.now() < deadline && polls < maxPolls) {
      polls += 1;
      await input.port.wait(pollIntervalSeconds);
      // Reuse the first settle to grab transient toasts before they dismiss.
      if (!alertChecked) {
        alertChecked = true;
        alertSeen = await input.port.captureTransientAlert(0);
      }
      try {
        const pollExtract = await input.port.extractCredentials();
        mergeFirstWins(input.credentials, pollExtract);
        try {
          const pollLabeled = await input.port.extractFromDomProximity();
          mergeFirstWins(input.credentials, pollLabeled);
        } catch {
          // DOM-proximity failure is non-fatal; the next poll/round can retry.
        }
        if (input.credentials.api_key !== undefined) break;
      } catch {
        // Page mid-render; keep polling until the deadline.
      }
    }

    return {
      alertSeen,
      foundApiKey: input.credentials.api_key !== undefined,
    };
  }
}

function mergeFirstWins(
  target: Record<string, string>,
  source: Record<string, string>,
): string[] {
  const newKeys: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (target[key] !== undefined) continue;
    target[key] = value;
    newKeys.push(key);
  }
  return newKeys;
}

function summarizeCredential(key: string, value: string): string {
  return `${key}=${value.slice(0, 4)}…${value.slice(-4)}`;
}
