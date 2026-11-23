const COMPLETION_PROVIDER_STORAGE_PREFIX = "ts-install-completion-provider:";
type InstallCompletionProvider = "google" | "github";
const INSTALL_COMPLETION_PROVIDERS: readonly InstallCompletionProvider[] = ["google", "github"];
const FINISH_ATTEMPTS = 3;
const FINISH_RETRY_MS = 1_000;

export function clearInstallCompletionProviders(token: string): void {
  if (typeof window === "undefined") return;
  try {
    for (const provider of INSTALL_COMPLETION_PROVIDERS) {
      window.sessionStorage.removeItem(`${COMPLETION_PROVIDER_STORAGE_PREFIX}${token}:${provider}`);
    }
  } catch {
    // Best-effort cleanup after Finish.
  }
}

export function recordInstallCompletionProvider(
  token: string,
  provider: InstallCompletionProvider,
): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(`${COMPLETION_PROVIDER_STORAGE_PREFIX}${token}:${provider}`, "1");
  } catch {
    // The current page can still report its in-memory completion state.
  }
}

export function readInstallCompletionProviders(token: string): InstallCompletionProvider[] {
  if (typeof window === "undefined") return [];
  try {
    return INSTALL_COMPLETION_PROVIDERS.filter(
      (provider) =>
        window.sessionStorage.getItem(
          `${COMPLETION_PROVIDER_STORAGE_PREFIX}${token}:${provider}`,
        ) === "1",
    );
  } catch {
    return [];
  }
}

// Finish is recorded on the server, same-origin, and the broker that owns the
// sign-in window reads it from there. A loopback call to the local machine
// would need Chrome's Local Network Access permission, which nobody is asked
// for, so the server is the only channel. The page moves to /install/done at
// once; the record is retried briefly in the background so one dropped
// request does not leave the window open until the pairing deadline.
export function finishInstallCeremony(
  token: string,
  navigateDone: () => void,
  post: (path: string) => Promise<unknown>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  const path = `/v1/mcp/install/${encodeURIComponent(token)}/finish`;
  const recorded = (async () => {
    for (let attempt = 1; attempt <= FINISH_ATTEMPTS; attempt += 1) {
      try {
        await post(path);
        return true;
      } catch {
        if (attempt < FINISH_ATTEMPTS) await sleep(FINISH_RETRY_MS);
      }
    }
    return false;
  })();
  navigateDone();
  return recorded;
}
