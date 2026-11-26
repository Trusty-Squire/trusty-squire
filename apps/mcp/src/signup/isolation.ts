// Isolation guards and secret-redaction helpers for embedded signup runs.
//
// Embedded callers (such as Grunt) must operate against their own Chrome
// profile directory (or explicit CDP endpoint) and their own session storage,
// never silently reusing or overwriting Trusty Squire's personal Chrome
// profile or personal session store.

import { lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CHROME_PROFILE_DIR, currentProfileDir, profilePathIdentity } from "../bot/profile-path.js";

export type SignupConfigErrorCode =
  | "browser_target_required"
  | "profile_dir_required"
  | "invalid_cdp_endpoint"
  | "default_profile_forbidden"
  | "session_path_required"
  | "default_session_store_forbidden"
  | "session_required"
  | "callback_required"
  | "invalid_url"
  | "goal_required";

export class SignupConfigError extends Error {
  constructor(
    readonly code: SignupConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SignupConfigError";
  }
}

export class SignupProfileIsolationError extends SignupConfigError {
  constructor(
    readonly profileDir: string,
    message: string,
  ) {
    super("default_profile_forbidden", message);
    this.name = "SignupProfileIsolationError";
  }
}

export class SignupSessionIsolationError extends SignupConfigError {
  constructor(
    readonly sessionPath: string,
    message: string,
  ) {
    super("default_session_store_forbidden", message);
    this.name = "SignupSessionIsolationError";
  }
}

function canonicalPathResolvingDanglingSymlinks(inputPath: string): string {
  let current = resolve(inputPath);
  for (let hops = 0; hops < 16; hops += 1) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        current = resolve(dirname(current), readlinkSync(current));
        continue;
      }
    } catch {
      break;
    }
    break;
  }
  return profilePathIdentity(current);
}

function isSameOrInsidePath(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  if (rel === "") return true;
  return !rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith("../");
}

function defaultSquireProfileRoots(): string[] {
  const candidates = [
    CHROME_PROFILE_DIR,
    currentProfileDir(),
    join(homedir(), ".trusty-squire", "chrome-profile"),
  ];
  return [...new Set(candidates.map((dir) => canonicalPathResolvingDanglingSymlinks(dir)))];
}

function defaultSquireConfigRoots(): string[] {
  const candidates = [
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "trusty-squire"),
    join(homedir(), ".config", "trusty-squire"),
  ];
  return [...new Set(candidates.map((dir) => canonicalPathResolvingDanglingSymlinks(dir)))];
}

/**
 * Validates that a caller-supplied Chrome profile directory is non-empty and
 * does not alias Trusty Squire's shared personal profile unless explicitly
 * opted in via `allowDefaultProfile: true`.
 */
export function assertIsolatedProfileDir(
  profileDir: string,
  options: { allowDefaultProfile?: boolean } = {},
): string {
  const trimmed = profileDir.trim();
  if (trimmed.length === 0) {
    throw new SignupConfigError(
      "profile_dir_required",
      "Embedded signup requires a non-empty profileDir (or cdpEndpoint).",
    );
  }
  const canonical = canonicalPathResolvingDanglingSymlinks(trimmed);
  if (options.allowDefaultProfile === true) return canonical;
  for (const forbidden of defaultSquireProfileRoots()) {
    if (isSameOrInsidePath(canonical, forbidden)) {
      throw new SignupProfileIsolationError(
        canonical,
        `Refusing to use Trusty Squire's personal Chrome profile (${forbidden}) for embedded signup. ` +
          `Pass an app-owned profileDir, or set allowDefaultProfile: true to opt in explicitly.`,
      );
    }
  }
  return canonical;
}

/**
 * Validates that an explicit session storage path does not point into Trusty
 * Squire's personal session config directory unless explicitly opted in via
 * `allowDefaultSessionStore: true`.
 */
export function assertIsolatedSessionPath(
  sessionPath: string,
  options: { allowDefaultSessionStore?: boolean } = {},
): string {
  const trimmed = sessionPath.trim();
  if (trimmed.length === 0) {
    throw new SignupConfigError(
      "session_path_required",
      "sessionPath must be a non-empty file path when provided.",
    );
  }
  const canonical = canonicalPathResolvingDanglingSymlinks(trimmed);
  if (options.allowDefaultSessionStore === true) return canonical;
  for (const forbidden of defaultSquireConfigRoots()) {
    if (isSameOrInsidePath(canonical, forbidden)) {
      throw new SignupSessionIsolationError(
        canonical,
        `Refusing to read or write Trusty Squire's personal session store (${forbidden}) during embedded signup. ` +
          `Pass an app-owned sessionPath, or set allowDefaultSessionStore: true to opt in explicitly.`,
      );
    }
  }
  return canonical;
}

export interface ResolvedSignupBrowserTarget {
  profileDir?: string;
  cdpEndpoint?: string;
}

export function resolveSignupBrowserTarget(options: {
  profileDir?: string | undefined;
  cdpEndpoint?: string | undefined;
  allowDefaultProfile?: boolean | undefined;
}): ResolvedSignupBrowserTarget {
  const rawProfileDir = options.profileDir?.trim() ?? "";
  const rawCdpEndpoint = options.cdpEndpoint?.trim() ?? "";
  if (rawProfileDir.length === 0 && rawCdpEndpoint.length === 0) {
    throw new SignupConfigError(
      "browser_target_required",
      "Embedded signup requires an explicit profileDir or cdpEndpoint; refusing to fall back to Trusty Squire's default Chrome profile.",
    );
  }
  const resolved: ResolvedSignupBrowserTarget = {};
  if (rawProfileDir.length > 0) {
    resolved.profileDir = assertIsolatedProfileDir(rawProfileDir, {
      ...(options.allowDefaultProfile !== undefined
        ? { allowDefaultProfile: options.allowDefaultProfile }
        : {}),
    });
  }
  if (rawCdpEndpoint.length > 0) {
    let parsed: URL;
    try {
      parsed = new URL(rawCdpEndpoint);
    } catch {
      throw new SignupConfigError(
        "invalid_cdp_endpoint",
        `Invalid cdpEndpoint URL: must be an http(s) or ws(s) endpoint.`,
      );
    }
    if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
      throw new SignupConfigError(
        "invalid_cdp_endpoint",
        `Invalid cdpEndpoint protocol (${parsed.protocol}): must be http:, https:, ws:, or wss:.`,
      );
    }
    resolved.cdpEndpoint = rawCdpEndpoint;
  }
  return resolved;
}

/**
 * Replaces every occurrence of any captured secret string with `[REDACTED]`.
 * Secrets are matched longest-first so shorter fragments cannot leave tails.
 */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  const unique = [...new Set([...secrets].map((s) => s.trim()).filter((s) => s.length >= 3))].sort(
    (a, b) => b.length - a.length,
  );
  if (unique.length === 0 || text.length === 0) return text;
  let result = text;
  for (const secret of unique) {
    if (result.includes(secret)) {
      result = result.split(secret).join("[REDACTED]");
    }
  }
  return result;
}

/**
 * Recursively redacts secret strings inside returned metadata/handoff objects.
 */
export function redactUnknownSecrets<T>(value: T, secrets: Iterable<string>): T {
  const list = [...new Set([...secrets].map((s) => s.trim()).filter((s) => s.length >= 3))];
  if (list.length === 0) return value;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return redactSecrets(node, list);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
        out[key] = walk(entry);
      }
      return out;
    }
    return node;
  };
  return walk(value) as T;
}
