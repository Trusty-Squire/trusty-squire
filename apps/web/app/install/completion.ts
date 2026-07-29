const COMPLETION_FRAGMENT_KEY = "ts_install_complete";
const COMPLETION_STORAGE_PREFIX = "ts-install-completion:";
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
    } catch {
      // The live value is still usable when session storage is unavailable.
    }
    return fromFragment;
  }
  try {
    return normalizeInstallCompletionUrl(window.sessionStorage.getItem(storageKey));
  } catch {
    return null;
  }
}

export function clearInstallCompletionUrl(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(`${COMPLETION_STORAGE_PREFIX}${token}`);
  } catch {
    // Best-effort cleanup after Finish.
  }
}
