const COMPLETION_FRAGMENT_KEY = "ts_install_complete";
const COMPLETION_ACK_FRAGMENT_KEY = "ts_install_complete_ack";
const COMPLETION_STORAGE_PREFIX = "ts-install-completion:";
const COMPLETION_ACK_STORAGE_PREFIX = "ts-install-completion-ack:";
const COMPLETION_PATH = /^\/\.well-known\/trusty-squire\/install-complete\/[a-f0-9]{48}$/;

export function normalizeInstallCompletionUrl(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    const port = Number(url.port);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65_535 ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      !COMPLETION_PATH.test(url.pathname)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function readInstallCompletionUrl(token: string): string | null {
  if (typeof window === "undefined") return null;
  const storageKey = `${COMPLETION_STORAGE_PREFIX}${token}`;
  const fromFragment = normalizeInstallCompletionUrl(
    new URLSearchParams(window.location.hash.slice(1)).get(COMPLETION_FRAGMENT_KEY),
  );
  if (fromFragment !== null) {
    try {
      window.sessionStorage.setItem(storageKey, fromFragment);
      return fromFragment;
    } catch {
      // OAuth removes the fragment on its redirect back to this page. Do not
      // acknowledge callback support unless the callback survived into
      // session storage; the MCP client will retain its legacy seeded-session
      // fallback instead of waiting forever for a callback we can no longer
      // deliver.
      return null;
    }
  }
  try {
    return normalizeInstallCompletionUrl(window.sessionStorage.getItem(storageKey));
  } catch {
    return null;
  }
}

export function installCompletionAcknowledgementUrl(
  token: string,
  callbackUrl: string,
): string | null {
  if (typeof window === "undefined") return null;
  const storageKey = `${COMPLETION_ACK_STORAGE_PREFIX}${token}`;
  const acknowledged =
    new URLSearchParams(window.location.hash.slice(1)).get(COMPLETION_ACK_FRAGMENT_KEY) === "1";
  if (acknowledged) {
    try {
      window.sessionStorage.setItem(storageKey, "1");
    } catch {
      // The current acknowledgement remains usable without storage.
    }
    return null;
  }
  try {
    if (window.sessionStorage.getItem(storageKey) === "1") return null;
  } catch {
    // Retry the handshake when storage is unavailable.
  }
  const normalized = normalizeInstallCompletionUrl(callbackUrl);
  if (normalized === null) return null;
  const acknowledgement = new URL(normalized);
  acknowledgement.pathname = `${acknowledgement.pathname}/ack`;
  return acknowledgement.toString();
}

export function clearInstallCompletionUrl(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(`${COMPLETION_STORAGE_PREFIX}${token}`);
    window.sessionStorage.removeItem(`${COMPLETION_ACK_STORAGE_PREFIX}${token}`);
  } catch {
    // Best-effort cleanup after Finish.
  }
}
