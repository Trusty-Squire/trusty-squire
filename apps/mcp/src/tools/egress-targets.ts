// Vault-first egress targets — `use_credential { target }`.
//
// The point: make the vault path the SHORTEST path from "key on a page" to
// "key where it's needed". `operate_act { kind: "extract", store }` puts the
// key in the vault and hands back a reference; this module takes that
// reference and puts the key into a GitHub Actions secret or a `.env` file.
// Two calls, and the model's context never contains the key.
//
// Residency: vault (encrypted at rest) → API memory (decrypt, re-seal to this
// process's ephemeral public key) → this process's memory (decrypt, act) →
// the destination. Never the model, never the wire in clear.
//
// Authorization reuses the boundary that already exists: the destination host
// must be on the credential's `allowed_hosts` (server-side, pre-decrypt), and
// a `.env` path must resolve under the project root the MCP was launched in.
// There is deliberately no new approval subsystem here.
//
// Deliberately NOT a plugin framework: two kinds, one `switch`. Fly, Vercel
// and Cloudflare targets are deferred until there is a second real user of
// the shape (see TODOS.md).

import { execFile } from "node:child_process";
import { constants, generateKeyPairSync, privateDecrypt, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
// Type-only, so the wasm module is NOT eagerly loaded — the value comes from
// the dynamic import in loadSodium() below.
import type SodiumModule from "libsodium-wrappers";
import type { ApiClient } from "../api-client.js";

const execFileAsync = promisify(execFile);

// `gh auth token` is a local keychain read; if it hasn't answered in 10s it
// is wedged (a locked keyring prompt), not slow.
const GH_TOKEN_TIMEOUT_MS = 10_000;
// One bound per GitHub call. No retry loop: a failed egress is reported to the
// user with GitHub's own words, not silently attempted again.
const GITHUB_CALL_TIMEOUT_MS = 15_000;

const GITHUB_API_HOST = "api.github.com";
// Mirrors the vault's EGRESS_LOCAL_FILE_HOST: `.env` has no network host, so
// the server records this sentinel instead of host-checking it.
const LOCAL_FILE_HOST = "local-file";

export class EgressTargetError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EgressTargetError";
  }
}

// ── the vault → local process envelope ───────────────────────────────────
//
// Generate an ephemeral RSA keypair, hand the public half to whichever
// sealed-fetch route applies, decrypt the sealed fields locally. Factored out
// of `operate_seal_vault_credential`, which still uses it against
// /v1/vault/browser-fill; egress uses it against /v1/vault/egress-fetch. The
// private key never leaves this call.

export interface SealedFieldsResponse {
  reference: string;
  encrypted_fields: Record<string, string>;
}

export async function fetchVaultFieldsSealed(
  requestSealed: (publicKeyPem: string) => Promise<SealedFieldsResponse>,
): Promise<{ reference: string; fields: Record<string, string> }> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const response = await requestSealed(publicKey);
  const fields: Record<string, string> = {};
  for (const [field, encrypted] of Object.entries(response.encrypted_fields)) {
    fields[field] = privateDecrypt(
      {
        key: privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(encrypted, "base64"),
    ).toString("utf8");
  }
  return { reference: response.reference, fields };
}

// ── field selection ──────────────────────────────────────────────────────
//
// The same rule `${SECRET}` follows server-side (http-proxy.ts resolveField),
// mirrored here because the destination call is made locally: named field →
// `value` → the sole field → the one secret-ish name.

const SECRETISH =
  /(?:secret|api[_-]?key|access[_-]?key|auth[_-]?token|\btoken\b|password|private[_-]?key|\bkey\b)/i;
const NON_SECRET =
  /^(?:id|name|label|username|user|email|public[_-]?key|client[_-]?id|account[_-]?id)$/i;

export function resolveEgressField(
  fields: Record<string, string>,
  name: string | undefined,
): string {
  if (name !== undefined) {
    const value = fields[name];
    if (value === undefined) {
      throw new EgressTargetError(
        "credential_field_missing",
        `credential has no field '${name}' — call list_credentials to see its field names`,
      );
    }
    return value;
  }
  if (fields.value !== undefined) return fields.value;
  const keys = Object.keys(fields);
  if (keys.length === 1) return fields[keys[0]!]!;
  const secretish = keys.filter((k) => SECRETISH.test(k) && !NON_SECRET.test(k));
  if (secretish.length === 1) return fields[secretish[0]!]!;
  throw new EgressTargetError(
    "credential_field_ambiguous",
    `credential has multiple fields (${keys.join(", ")}) — pass \`field\` to pick one`,
  );
}

// ── .env grammar ─────────────────────────────────────────────────────────
//
// Deliberately narrow. Every shape this doesn't understand is REFUSED with
// `dotenv_unsupported_format` rather than guessed at, because a wrong guess
// against a `.env` either loses the user's config or writes a secret twice.

export function serializeDotenvValue(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new EgressTargetError(
      "dotenv_value_unsupported",
      "the credential value contains a newline, which has no single-line .env representation",
    );
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function assignmentPatterns(name: string): { strict: RegExp; loose: RegExp } {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    strict: new RegExp(`^[ \\t]*(?:export[ \\t]+)?${escaped}=`),
    // Anything that READS as an assignment to this key but isn't the exact
    // grammar above (`FOO = bar`, say). Detected only so it can be refused —
    // appending beside it would silently create a duplicate key.
    loose: new RegExp(`^[ \\t]*(?:export[ \\t]+)?${escaped}[ \\t]*=`),
  };
}

// True when the value on a matched line continues past the end of the line —
// a trailing backslash, or an unterminated quote. We cannot rewrite one line
// of a multi-line value without understanding the rest of it, so we refuse.
function valueContinues(rawValue: string): boolean {
  const value = rawValue.replace(/\r?\n$/, "");
  if (/(^|[^\\])\\$/.test(value) || value === "\\") return true;
  const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : null;
  if (quote === null) return false;
  const body = value.slice(1);
  const closer = new RegExp(`(?:^|[^\\\\])${quote}`);
  return !closer.test(body) && !body.startsWith(quote);
}

// Replace exactly the one `NAME=` line, preserving every other byte — CRLF
// endings, comments, blank lines, and the `export ` prefix if it was there.
// Creates the assignment at the end when the key is absent.
export function applyDotenvAssignment(
  existing: string | null,
  name: string,
  value: string,
): string {
  const serialized = serializeDotenvValue(value);
  if (existing === null || existing.length === 0) {
    return `${name}=${serialized}\n`;
  }
  const { strict, loose } = assignmentPatterns(name);
  // Split keeping each line's terminator, so CRLF survives a rewrite.
  const lines = existing.split(/(?<=\n)/);
  const strictHits: number[] = [];
  const looseHits: number[] = [];
  lines.forEach((line, index) => {
    if (strict.test(line)) strictHits.push(index);
    else if (loose.test(line)) looseHits.push(index);
  });

  if (strictHits.length + looseHits.length > 1) {
    throw new EgressTargetError(
      "dotenv_unsupported_format",
      `${name} appears more than once in this .env — resolve the duplicate by hand, then retry`,
    );
  }
  if (looseHits.length === 1) {
    throw new EgressTargetError(
      "dotenv_unsupported_format",
      `${name} is assigned in a form this writer does not parse (expected \`${name}=\` or \`export ${name}=\` at line start)`,
    );
  }
  if (strictHits.length === 0) {
    const separator = existing.endsWith("\n") ? "" : "\n";
    return `${existing}${separator}${name}=${serialized}\n`;
  }

  const index = strictHits[0]!;
  const line = lines[index]!;
  const match = strict.exec(line)!;
  const prefix = match[0];
  const rest = line.slice(prefix.length);
  if (valueContinues(rest)) {
    throw new EgressTargetError(
      "dotenv_unsupported_format",
      `${name} currently holds a multi-line or continued value — replace it by hand, then retry`,
    );
  }
  const terminator = /\r?\n$/.exec(rest)?.[0] ?? "";
  lines[index] = `${prefix}${serialized}${terminator}`;
  return lines.join("");
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

// A cwd that isn't a project makes the gate below vacuous: rooted at `/` it
// authorises the whole filesystem, and rooted at $HOME it authorises every
// project plus ~/.ssh. Both happen for real — Goose Desktop spawns MCP
// extensions with cwd=/ (see CLAUDE.md) — so refuse rather than write.
export function unsafeProjectRoot(root: string, home: string | undefined): boolean {
  if (root === path.parse(root).root) return true;
  return home !== undefined && home.length > 0 && path.resolve(home) === root;
}

// The `.env` authorization gate: the path must land under the project root the
// MCP server was launched in, with symlinks resolved. This is the whole reason
// `dotenv_write` needs no separate approval — the agent cannot aim it at
// ~/.ssh or another project.
export async function resolveDotenvPath(rawPath: string): Promise<string> {
  const projectRoot = await fs.realpath(process.cwd());
  if (unsafeProjectRoot(projectRoot, process.env.HOME ?? process.env.USERPROFILE)) {
    throw new EgressTargetError(
      "project_root_unsafe",
      `this MCP server was launched in ${projectRoot}, which is not a project directory — ` +
        "a .env write there would be unbounded. Relaunch the server from the project, or " +
        "use a github_repo_secret target instead.",
    );
  }
  const absolute = path.resolve(projectRoot, rawPath);
  // Lexical check first, so a path that plainly escapes gets the escape error
  // rather than being reported as a missing directory.
  if (!isInside(projectRoot, absolute)) {
    throw new EgressTargetError(
      "path_outside_project",
      `${rawPath} resolves outside the project root (${projectRoot}); .env writes are confined to it`,
    );
  }
  let realDir: string;
  try {
    realDir = await fs.realpath(path.dirname(absolute));
  } catch {
    // We cannot prove a nonexistent directory is inside the root, and creating
    // one to find out is not this tool's job.
    throw new EgressTargetError(
      "dotenv_directory_missing",
      `the directory for ${rawPath} does not exist — create it, then retry`,
    );
  }
  const resolved = path.join(realDir, path.basename(absolute));
  if (!isInside(projectRoot, resolved)) {
    throw new EgressTargetError(
      "path_outside_project",
      `${rawPath} resolves outside the project root (${projectRoot}); .env writes are confined to it`,
    );
  }
  // An existing file may itself be a symlink out of the project.
  try {
    const realFile = await fs.realpath(resolved);
    if (!isInside(projectRoot, realFile)) {
      throw new EgressTargetError(
        "path_outside_project",
        `${rawPath} is a symlink pointing outside the project root (${projectRoot})`,
      );
    }
    return realFile;
  } catch (err) {
    if (err instanceof EgressTargetError) throw err;
    return resolved;
  }
}

// Atomic + 0600. The temp file is created in the destination directory so the
// rename cannot cross a filesystem, and it carries 0600 from birth so the
// secret is never briefly world-readable.
async function writeFileAtomic0600(target: string, content: string): Promise<void> {
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await fs.writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// ── GitHub Actions secrets ───────────────────────────────────────────────

export interface EgressTargetDeps {
  fetch: typeof globalThis.fetch;
  githubToken: () => Promise<string>;
  // Seals the plaintext to the repo's public key. Injected so the unit tests
  // can assert the exact bytes GitHub would receive without re-implementing
  // libsodium's box.
  sealForGithub: (plaintext: Buffer, publicKeyBase64: string) => Promise<string>;
}

// Resolve the GitHub token exactly the way a developer expects: whatever `gh`
// is already logged in as, else GITHUB_TOKEN. Names both fixes when neither
// is there — a missing token is the single most likely failure here.
export async function resolveGithubToken(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      timeout: GH_TOKEN_TIMEOUT_MS,
      encoding: "utf8",
    });
    const token = stdout.trim();
    if (token.length > 0) return token;
  } catch {
    // `gh` missing, not logged in, or wedged — fall through to the env var.
  }
  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  throw new EgressTargetError(
    "github_auth_missing",
    "no GitHub token available: run `gh auth login`, or set GITHUB_TOKEN in this MCP server's environment",
  );
}

type Sodium = typeof SodiumModule;

let sodiumReady: Promise<Sodium> | null = null;

// libsodium is what GitHub's own docs prescribe for Actions secrets, and Node
// has no crypto_box_seal. Loaded lazily once so an mcp server that never does
// GitHub egress never pays for the wasm init.
async function loadSodium(): Promise<Sodium> {
  sodiumReady ??= (async () => {
    const sodium = (await import("libsodium-wrappers")).default;
    await sodium.ready;
    return sodium;
  })();
  return sodiumReady;
}

async function sealForGithub(plaintext: Buffer, publicKeyBase64: string): Promise<string> {
  const sodium = await loadSodium();
  const publicKey = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(new Uint8Array(plaintext), publicKey);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

export const DEFAULT_EGRESS_TARGET_DEPS: EgressTargetDeps = {
  fetch: (...args) => globalThis.fetch(...args),
  githubToken: resolveGithubToken,
  sealForGithub,
};

async function githubRequest(
  deps: EgressTargetDeps,
  token: string,
  url: string,
  init: { method: string; body?: string },
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_CALL_TIMEOUT_MS);
  try {
    const response = await deps.fetch(url, {
      method: init.method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "trusty-squire-mcp",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: controller.signal,
    });
    return { status: response.status, text: await response.text() };
  } catch (err) {
    // An abort is the 15s bound firing. Surfaced, never retried.
    const reason = err instanceof Error ? err.message : String(err);
    throw new EgressTargetError(
      "github_request_failed",
      `${init.method} ${url} failed: ${controller.signal.aborted ? `timed out after ${GITHUB_CALL_TIMEOUT_MS}ms` : reason}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function isGithubPublicKey(value: unknown): value is { key: string; key_id: string } {
  if (typeof value !== "object" || value === null) return false;
  const record: Record<string, unknown> = { ...value };
  return typeof record.key === "string" && typeof record.key_id === "string";
}

function githubSecretsBase(owner: string, repo: string, environment?: string): string {
  const base = `https://${GITHUB_API_HOST}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return environment === undefined
    ? `${base}/actions/secrets`
    : `${base}/environments/${encodeURIComponent(environment)}/secrets`;
}

// ── the target switch ────────────────────────────────────────────────────

// One source of truth for the target shape: `use_credential` validates with
// this schema, and every function below types against what it infers.
const secretName = z
  .string()
  .min(1)
  .max(200)
  // GitHub's own constraint on an Actions secret name; also the safe shape for
  // a .env variable.
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "name must match [A-Za-z_][A-Za-z0-9_]*");

export const egressTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("github_repo_secret"),
    owner: z.string().min(1).max(200),
    repo: z.string().min(1).max(200),
    name: secretName,
    environment: z.string().min(1).max(200).optional(),
  }),
  z.object({
    kind: z.literal("dotenv_write"),
    // Resolved against the project root the MCP server was launched in; a path
    // that escapes it is refused (`path_outside_project`).
    path: z.string().min(1).max(1024),
    name: secretName,
  }),
]);

export type EgressTarget = z.infer<typeof egressTargetSchema>;
export type GithubRepoSecretTarget = Extract<EgressTarget, { kind: "github_repo_secret" }>;

export interface EgressCredentialSelector {
  reference?: string;
  service?: string;
  name?: string;
}

// The audit destination identity — what received the key, never its value.
// For `.env` this is the RESOLVED path, not what the caller typed: the audit
// trail must name the file that was actually written.
function outcomeDestination(
  target: EgressTarget,
):
  | { kind: "github_repo_secret"; repo: string; environment?: string }
  | { kind: "dotenv_write"; path: string } {
  return target.kind === "dotenv_write"
    ? { kind: "dotenv_write", path: target.path }
    : {
        kind: "github_repo_secret",
        repo: `${target.owner}/${target.repo}`,
        ...(target.environment !== undefined ? { environment: target.environment } : {}),
      };
}

async function reportOutcome(
  api: ApiClient,
  reference: string,
  target: EgressTarget,
  status: "ok" | "error",
  error?: string,
): Promise<void> {
  try {
    await api.reportEgressOutcome({
      reference,
      destination: outcomeDestination(target),
      status,
      ...(error !== undefined ? { error } : {}),
    });
  } catch (err) {
    // The delivery already happened (or already failed). A missing audit row
    // must never turn a successful egress into a reported failure.
    process.stderr.write(
      `[trusty-squire] egress outcome report failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

export async function executeEgressTarget(
  api: ApiClient,
  args: { selector: EgressCredentialSelector; field?: string; target: EgressTarget },
  deps: EgressTargetDeps = DEFAULT_EGRESS_TARGET_DEPS,
): Promise<Record<string, unknown>> {
  const { target } = args;
  const destinationHost = target.kind === "dotenv_write" ? LOCAL_FILE_HOST : GITHUB_API_HOST;

  // The `.env` path gate runs BEFORE the fetch: a path outside the project is
  // a refusal, not a decrypt followed by a refusal.
  const dotenvPath = target.kind === "dotenv_write" ? await resolveDotenvPath(target.path) : null;
  const audited: EgressTarget =
    target.kind === "dotenv_write" ? { ...target, path: dotenvPath! } : target;

  const { reference, fields } = await fetchVaultFieldsSealed((publicKey) =>
    api.egressFetchCredential({
      ...args.selector,
      ...(args.field !== undefined ? { fields: [args.field] } : {}),
      encrypted_response_public_key: publicKey,
      destination: { kind: target.kind, host: destinationHost },
    }),
  );

  let secret: string | null = null;
  try {
    secret = resolveEgressField(fields, args.field);
    let result: Record<string, unknown>;
    if (target.kind === "github_repo_secret") {
      const put = await putGithubSecret(deps, target, secret);
      secret = null;
      result = {
        ok: true,
        destination: {
          kind: "github_repo_secret",
          repo: `${target.owner}/${target.repo}`,
          name: target.name,
          ...(target.environment !== undefined ? { environment: target.environment } : {}),
        },
        status: put.status,
      };
    } else {
      const written = await writeDotenv(dotenvPath!, target.name, secret);
      secret = null;
      result = { written: true, path: written.path, name: target.name, created: written.created };
    }
    await reportOutcome(api, reference, audited, "ok");
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await reportOutcome(api, reference, audited, "error", message);
    throw err;
  } finally {
    // Best effort: JS strings are immutable and GC-owned, so the most we can
    // do is drop every reference we hold as soon as the destination has it.
    secret = null;
    for (const key of Object.keys(fields)) delete fields[key];
  }
}

async function putGithubSecret(
  deps: EgressTargetDeps,
  target: GithubRepoSecretTarget,
  secret: string,
): Promise<{ status: number }> {
  const token = await deps.githubToken();
  const base = githubSecretsBase(target.owner, target.repo, target.environment);

  const publicKeyResponse = await githubRequest(deps, token, `${base}/public-key`, {
    method: "GET",
  });
  if (publicKeyResponse.status < 200 || publicKeyResponse.status >= 300) {
    throw new EgressTargetError(
      "github_request_failed",
      `GitHub returned ${publicKeyResponse.status} fetching the encryption key for ${target.owner}/${target.repo}: ${publicKeyResponse.text}`,
    );
  }
  const parsed: unknown = JSON.parse(publicKeyResponse.text);
  if (!isGithubPublicKey(parsed)) {
    throw new EgressTargetError(
      "github_request_failed",
      `GitHub's public-key response for ${target.owner}/${target.repo} had no key/key_id`,
    );
  }

  const plaintext = Buffer.from(secret, "utf8");
  let encryptedValue: string;
  try {
    encryptedValue = await deps.sealForGithub(plaintext, parsed.key);
  } finally {
    plaintext.fill(0);
  }

  const put = await githubRequest(deps, token, `${base}/${encodeURIComponent(target.name)}`, {
    method: "PUT",
    body: JSON.stringify({ encrypted_value: encryptedValue, key_id: parsed.key_id }),
  });
  if (put.status < 200 || put.status >= 300) {
    throw new EgressTargetError(
      "github_request_failed",
      `GitHub returned ${put.status} setting secret ${target.name} on ${target.owner}/${target.repo}: ${put.text}`,
    );
  }
  return { status: put.status };
}

async function writeDotenv(
  resolvedPath: string,
  name: string,
  secret: string,
): Promise<{ path: string; created: boolean }> {
  let existing: string | null = null;
  try {
    existing = await fs.readFile(resolvedPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
  const next = applyDotenvAssignment(existing, name, secret);
  await writeFileAtomic0600(resolvedPath, next);
  return { path: resolvedPath, created: existing === null };
}
