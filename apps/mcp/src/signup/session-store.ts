// Isolated session storage for embedded signup callers.
//
// Writes a single 0600 JSON file atomically at the caller's chosen path and
// refuses to touch Trusty Squire's personal session store unless explicitly
// opted in.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { assertIsolatedSessionPath, SignupConfigError } from "./isolation.js";

export const DEFAULT_SIGNUP_API_BASE_URL = "https://trusty-squire-api.fly.dev";
export const DEFAULT_SIGNUP_REGISTRY_BASE_URL = "https://registry.trustysquire.ai";

export function resolveDefaultSignupApiBaseUrl(): string {
  const configured = (process.env.TRUSTY_SQUIRE_API_BASE ?? "").trim();
  return configured.length > 0 ? configured : DEFAULT_SIGNUP_API_BASE_URL;
}

export interface SignupSession {
  apiBaseUrl: string;
  accountId: string;
  agentSessionToken: string;
  machineToken: string;
  savedAt: string;
  registryBaseUrl?: string;
  consentOperatorInboxOtp?: boolean;
}

export interface SessionStoreGuardOptions {
  allowDefaultSessionStore?: boolean;
}

export function isCompleteSignupSession(
  value: Partial<SignupSession> | null | undefined,
): value is SignupSession {
  if (value === null || value === undefined || typeof value !== "object") return false;
  return (
    typeof value.apiBaseUrl === "string" &&
    value.apiBaseUrl.trim().length > 0 &&
    typeof value.accountId === "string" &&
    value.accountId.trim().length > 0 &&
    typeof value.agentSessionToken === "string" &&
    value.agentSessionToken.trim().length > 0 &&
    typeof value.machineToken === "string" &&
    value.machineToken.trim().length > 0
  );
}

function parseStoredSignupSession(raw: unknown): SignupSession | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const apiBaseUrl =
    typeof record.apiBaseUrl === "string"
      ? record.apiBaseUrl
      : typeof record.api_base_url === "string"
        ? record.api_base_url
        : undefined;
  const accountId =
    typeof record.accountId === "string"
      ? record.accountId
      : typeof record.account_id === "string"
        ? record.account_id
        : undefined;
  const agentSessionToken =
    typeof record.agentSessionToken === "string"
      ? record.agentSessionToken
      : typeof record.agent_session_token === "string"
        ? record.agent_session_token
        : undefined;
  const machineToken =
    typeof record.machineToken === "string"
      ? record.machineToken
      : typeof record.machine_token === "string"
        ? record.machine_token
        : undefined;
  const savedAt =
    typeof record.savedAt === "string"
      ? record.savedAt
      : typeof record.saved_at === "string"
        ? record.saved_at
        : new Date().toISOString();
  const registryBaseUrl =
    typeof record.registryBaseUrl === "string"
      ? record.registryBaseUrl
      : typeof record.registry_base_url === "string"
        ? record.registry_base_url
        : undefined;
  const consentOperatorInboxOtp =
    typeof record.consentOperatorInboxOtp === "boolean"
      ? record.consentOperatorInboxOtp
      : typeof record.consent_operator_inbox_otp === "boolean"
        ? record.consent_operator_inbox_otp
        : undefined;

  const parsed: Partial<SignupSession> = {
    ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
    ...(agentSessionToken !== undefined ? { agentSessionToken } : {}),
    ...(machineToken !== undefined ? { machineToken } : {}),
    savedAt,
    ...(registryBaseUrl !== undefined ? { registryBaseUrl } : {}),
    ...(consentOperatorInboxOtp !== undefined ? { consentOperatorInboxOtp } : {}),
  };
  return isCompleteSignupSession(parsed) ? parsed : null;
}

/**
 * Reads an embedded `SignupSession` from an explicit caller-owned JSON file.
 * Returns `null` when the file does not exist or does not hold a complete session.
 */
export async function readSignupSession(
  sessionPath: string,
  options: SessionStoreGuardOptions = {},
): Promise<SignupSession | null> {
  const safePath = assertIsolatedSessionPath(sessionPath, options);
  try {
    const raw = JSON.parse(await fs.readFile(safePath, "utf8")) as unknown;
    return parseStoredSignupSession(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Atomically writes an embedded `SignupSession` with 0600 permissions to the
 * caller-owned `sessionPath`. Never touches Squire's personal session store.
 */
export async function writeSignupSession(
  sessionPath: string,
  session: SignupSession,
  options: SessionStoreGuardOptions = {},
): Promise<void> {
  const safePath = assertIsolatedSessionPath(sessionPath, options);
  if (!isCompleteSignupSession(session)) {
    throw new SignupConfigError(
      "session_required",
      "SignupSession requires non-empty apiBaseUrl, accountId, agentSessionToken, and machineToken.",
    );
  }
  const dir = path.dirname(safePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const payload: SignupSession = {
    apiBaseUrl: session.apiBaseUrl,
    accountId: session.accountId,
    agentSessionToken: session.agentSessionToken,
    machineToken: session.machineToken,
    savedAt: session.savedAt || new Date().toISOString(),
    ...(session.registryBaseUrl !== undefined ? { registryBaseUrl: session.registryBaseUrl } : {}),
    ...(session.consentOperatorInboxOtp !== undefined
      ? { consentOperatorInboxOtp: session.consentOperatorInboxOtp }
      : {}),
  };
  const temporary = `${safePath}.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, safePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * Deletes an embedded session file at `sessionPath`. No-op if already absent.
 */
export async function clearSignupSession(
  sessionPath: string,
  options: SessionStoreGuardOptions = {},
): Promise<void> {
  const safePath = assertIsolatedSessionPath(sessionPath, options);
  try {
    await fs.unlink(safePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
