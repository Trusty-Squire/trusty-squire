"use client";

// Install wizard — one browser session, three steps.
//
//   1. Sign in with Google   (required — also binds the trustysquire
//                             account so the install can be claimed)
//   2. Connect GitHub        (recommended, skippable — most dev tools
//                             accept GitHub OAuth; some only accept
//                             GitHub)
//   3. Add payment method    (future — slot wired but hidden)
//
// State is derived from /v1/auth/whoami + /v1/mcp/install/<token>/state,
// polled every 3s after each redirect-return. The bot's Chrome stays
// on this page until the user clicks Finish (which navigates to
// /install/done — the bot's poll watches for that URL).

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiGet, apiPost } from "../lib/api";
import { useQueryParam } from "../lib/use-query-param";
import { Shield } from "../components/Shield";

type Provider = "google" | "github";
type InstallPairingStatus = "pending" | "claimed" | "delivered" | "expired";

interface InstallStatus {
  status: InstallPairingStatus;
  agent_identity?: string | null;
}

interface WhoamiResponse {
  signed_in: boolean;
  account_id?: string;
  identities: Provider[];
}

interface InstallPreferences {
  registry_enabled: boolean;
  consent_operator_inbox_otp: boolean;
  proxy_url?: string;
}

function readStoredInstallPreferences(): InstallPreferences {
  const fallback: InstallPreferences = {
    registry_enabled: false,
    consent_operator_inbox_otp: false,
  };
  if (typeof window === "undefined") return fallback;
  const token = new URLSearchParams(window.location.search).get("token");
  if (token === null) return fallback;
  try {
    const raw = window.localStorage.getItem(`ts-install-prefs:${token}`);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as Partial<InstallPreferences>;
    return {
      registry_enabled: parsed.registry_enabled === true,
      consent_operator_inbox_otp: parsed.consent_operator_inbox_otp === true,
      ...(typeof parsed.proxy_url === "string" ? { proxy_url: parsed.proxy_url } : {}),
    };
  } catch {
    return fallback;
  }
}

// Page-level state machine. Most renders are determined by `step` +
// the wizard step states; the rarer ones (loading the page, expired
// install, server error) get their own branches. The missing-token
// case is derived from `token` at render, not tracked here.
type PageState =
  | "loading"
  | "wizard"
  | "expired"
  | "error";

function isInstallConfirmed(status: InstallStatus["status"]): boolean {
  return status === "claimed" || status === "delivered";
}

export default function InstallPage() {
  const router = useRouter();
  const token = useQueryParam("token");
  const [page, setPage] = useState<PageState>("loading");
  const [agent, setAgent] = useState<string | null>(null);
  const [identities, setIdentities] = useState<Provider[]>([]);
  const [installClaimed, setInstallClaimed] = useState(false);
  const [skippedGithub, setSkippedGithub] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [preferences, setPreferences] = useState<InstallPreferences>(
    readStoredInstallPreferences,
  );
  const registryEnabled = preferences.registry_enabled;
  const otpEnabled = preferences.consent_operator_inbox_otp;
  const proxyUrl = preferences.proxy_url ?? "";

  // Returning from the OAuth round-trip — fire the claim if we
  // weren't already claimed. The wizard then continues to step 2.
  const returnedFromAuth = useQueryParam("claim") === "1";
  // Returning specifically from a GitHub sign-in done in THIS browser
  // (the bot's Chrome). Account-binding alone (whoami.identities) does NOT
  // mean the bot has a live github.com session — that link persists across
  // sessions while the bot's cookie expires. So GitHub step 2 only counts
  // as done when the OAuth ran here this session, which is what actually
  // (re)establishes the bot's github.com login.
  const returnedFromGithub = useQueryParam("gh") === "1";
  const [githubSessionFresh, setGithubSessionFresh] = useState(false);

  // Initial load: fetch state + whoami in parallel. A missing token is
  // handled at render (see below), so just bail here without touching state.
  useEffect(() => {
    if (token === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const [state, whoami] = await Promise.all([
          apiGet<InstallStatus>(
            `/v1/mcp/install/${encodeURIComponent(token)}/state`,
          ),
          apiGet<WhoamiResponse>(`/v1/auth/whoami`),
        ]);
        if (cancelled) return;
        if (state.status === "expired") {
          setPage("expired");
          return;
        }
        setAgent(state.agent_identity ?? null);
        setIdentities(whoami.identities);
        setInstallClaimed(isInstallConfirmed(state.status));
        setPage("wizard");
      } catch (err) {
        if (cancelled) return;
        setPage("error");
        setErrorText(
          err instanceof Error
            ? err.message
            : "Couldn't load this install request.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (token === null) return;
    const proxy = proxyUrl.trim();
    const prefs: InstallPreferences = {
      registry_enabled: registryEnabled,
      consent_operator_inbox_otp: otpEnabled,
      ...(proxy.length > 0 ? { proxy_url: proxy } : {}),
    };
    try {
      window.localStorage.setItem(`ts-install-prefs:${token}`, JSON.stringify(prefs));
    } catch {
      /* storage is advisory; the live React state still drives claim */
    }
  }, [token, registryEnabled, otpEnabled, proxyUrl]);

  // Auto-claim after the OAuth round-trip returns. The wizard's
  // step 1 ✓ depends on BOTH whoami.identities ⊇ ["google"] AND the
  // install being claimed. Once the CLI receives the agent token, the
  // server state moves from `claimed` to `delivered`; both are confirmed
  // from the browser's point of view.
  useEffect(() => {
    if (
      !returnedFromAuth ||
      token === null ||
      page !== "wizard" ||
      installClaimed ||
      !identities.includes("google")
    )
      return;
    let cancelled = false;
    void (async () => {
      try {
        await apiPost(
          `/v1/mcp/install/${encodeURIComponent(token)}/claim`,
          {
            ...(agent !== null ? { agent_identity: agent } : {}),
            registry_enabled: registryEnabled,
            consent_operator_inbox_otp: otpEnabled,
            ...(proxyUrl.trim().length > 0 ? { proxy_url: proxyUrl.trim() } : {}),
          },
        );
        if (cancelled) return;
        setInstallClaimed(true);
        // Strip the claim=1 marker so a page refresh doesn't try to
        // claim again (the API would reject the duplicate cleanly,
        // but the URL noise serves no purpose).
        router.replace(`/install?token=${encodeURIComponent(token)}`);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          // Race: whoami said signed-in but the cookie wasn't accepted.
          // Fall through to the wizard — step 1 will still surface
          // Continue-with-Google.
          return;
        }
        if (err instanceof ApiError && err.status === 409) {
          const state = await apiGet<InstallStatus>(
            `/v1/mcp/install/${encodeURIComponent(token)}/state`,
          );
          if (cancelled) return;
          if (state.status === "expired") {
            setPage("expired");
            return;
          }
          if (isInstallConfirmed(state.status)) {
            setInstallClaimed(true);
            router.replace(`/install?token=${encodeURIComponent(token)}`);
            return;
          }
        }
        setPage("error");
        setErrorText(
          err instanceof Error ? err.message : "Install failed. Try again.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    returnedFromAuth,
    token,
    page,
    installClaimed,
    identities,
    agent,
    router,
    registryEnabled,
    otpEnabled,
    proxyUrl,
  ]);

  // Light polling on whoami — covers the case where the user does
  // step 2 (GitHub) and the round-trip's redirect re-renders the
  // page. Poll only while the wizard is active and step 2 hasn't
  // landed yet, then stop.
  useEffect(() => {
    if (page !== "wizard") return;
    if (identities.includes("github") || skippedGithub) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const whoami = await apiGet<WhoamiResponse>(`/v1/auth/whoami`);
        if (!cancelled) setIdentities(whoami.identities);
      } catch {
        // Ignore transient poll errors.
      }
    };
    const id = window.setInterval(tick, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [page, identities, skippedGithub]);

  const startGoogle = useCallback(() => {
    if (token === null) return;
    window.location.href =
      `/v1/auth/oauth/google/start?next=` +
      encodeURIComponent(`/install?token=${encodeURIComponent(token)}&claim=1`);
  }, [token]);

  const startGithub = useCallback(() => {
    if (token === null) return;
    window.location.href =
      `/v1/auth/oauth/github/start?next=` +
      // `gh=1` marks the return so we know the bot's github.com session was
      // just (re)established here, vs. a stale account-only link.
      encodeURIComponent(`/install?token=${encodeURIComponent(token)}&gh=1`);
  }, [token]);

  // Once the GitHub OAuth returns here (gh=1) and the account confirms the
  // link, the bot's github.com cookie is live in this profile — mark the
  // step done. Sticky: survives the URL-marker cleanup below.
  useEffect(() => {
    if (returnedFromGithub && identities.includes("github")) {
      setGithubSessionFresh(true);
    }
  }, [returnedFromGithub, identities]);

  const skipGithub = useCallback(() => {
    setSkippedGithub(true);
  }, []);

  const finish = useCallback(() => {
    if (token !== null) {
      try {
        window.localStorage.removeItem(`ts-install-prefs:${token}`);
      } catch {
        /* ignore */
      }
    }
    router.push("/install/done");
  }, [router, token]);

  // ---- Render branches -----------------------------------------------

  // Missing token — derived directly from the query param, so no effect
  // has to set a "page" state to reach this branch.
  if (token === null) {
    return (
      <Shell>
        <h1>Invalid install link</h1>
        <p className="auth-sub">
          This link is missing its setup token. Run{" "}
          <code>npx @trusty-squire/mcp connect</code> again for a fresh one.
        </p>
      </Shell>
    );
  }

  if (page === "loading") {
    return (
      <Shell>
        <p className="auth-sub" style={loadingStyle}>
          <span className="spinner" /> Loading install request…
        </p>
      </Shell>
    );
  }

  if (page === "expired") {
    return (
      <Shell>
        <h1>Install link expired</h1>
        <p className="auth-sub">
          Install links last 10 minutes. Run{" "}
          <code>npx @trusty-squire/mcp connect</code> again for a fresh one.
        </p>
      </Shell>
    );
  }

  if (page === "error") {
    return (
      <Shell>
        <h1>Something went wrong</h1>
        <p className="auth-sub">{errorText}</p>
      </Shell>
    );
  }

  // page === "wizard"
  const step1Done = installClaimed && identities.includes("google");
  // GitHub: linked = bound to the account (may be a stale link); done = the
  // bot's github.com session was (re)established here this session.
  const githubLinked = identities.includes("github");
  const step2Done = githubSessionFresh;
  const step2Skipped = skippedGithub && !step2Done;
  const canFinish = step1Done; // step 2 is optional

  return (
    <Shell>
      <h1>Set up Trusty Squire</h1>
      <p className="auth-sub">
        {agent === null
          ? "Connect your coding agent to your account."
          : `Connect ${agent} to your account.`}
      </p>

      <div className="provider-state" aria-label="Provider connection status">
        <StatusPill label="Google" connected={identities.includes("google")} />
        <StatusPill
          label="GitHub"
          connected={step2Done}
          offLabel={githubLinked ? "linked — sign in to enable" : "not connected"}
        />
      </div>

      <AdvancedInstallSettings
        open={showAdvanced}
        disabled={installClaimed}
        registryEnabled={registryEnabled}
        otpEnabled={otpEnabled}
        proxyUrl={proxyUrl}
        onToggle={() => setShowAdvanced((v) => !v)}
        onRegistryChange={(value) =>
          setPreferences((current) => ({ ...current, registry_enabled: value }))
        }
        onOtpChange={(value) =>
          setPreferences((current) => ({
            ...current,
            consent_operator_inbox_otp: value,
          }))
        }
        onProxyChange={(value) =>
          setPreferences((current) => {
            if (value.trim().length > 0) return { ...current, proxy_url: value };
            const rest: InstallPreferences = {
              registry_enabled: current.registry_enabled,
              consent_operator_inbox_otp: current.consent_operator_inbox_otp,
            };
            return rest;
          })
        }
      />

      <ol className="wizard">
        <WizardStep
          number={1}
          title="Sign in with Google"
          required
          status={step1Done ? "done" : "pending"}
        >
          {!step1Done && (
            <button
              className="btn-primary"
              type="button"
              onClick={startGoogle}
            >
              Continue with Google
            </button>
          )}
        </WizardStep>

        <WizardStep
          number={2}
          title="Connect GitHub"
          hint="Highly recommended — some services (Railway, Vercel) only accept GitHub."
          status={step2Done ? "done" : step2Skipped ? "skipped" : "pending"}
          disabled={!step1Done}
        >
          {step1Done && !step2Done && !step2Skipped && (
            <div className="wizard-actions">
              {/* Account-linked but no live bot session: the link persists
                  across sessions while the bot's github.com cookie expires,
                  so a re-sign-in here is what actually lets the bot act. */}
              {githubLinked && (
                <span className="wizard-step-hint">
                  GitHub is linked to your account, but the bot needs its own
                  GitHub sign-in to act on it. Sign in here to establish (or
                  refresh) that session.
                </span>
              )}
              <button
                className="btn-primary"
                type="button"
                onClick={startGithub}
              >
                {githubLinked ? "Sign in to GitHub" : "Connect GitHub"}
              </button>
              <button
                className="btn-secondary"
                type="button"
                onClick={skipGithub}
              >
                Skip for now
              </button>
            </div>
          )}
          {step1Done && step2Done && (
            <div className="wizard-actions">
              <span className="wizard-step-hint">
                The bot has a working GitHub session.
              </span>
              <button
                className="btn-secondary"
                type="button"
                onClick={startGithub}
              >
                Re-sign in to GitHub
              </button>
            </div>
          )}
        </WizardStep>
      </ol>

      {canFinish && (
        <button className="btn-primary wizard-finish" type="button" onClick={finish}>
          Finish
        </button>
      )}
    </Shell>
  );
}

// ---- Sub-components --------------------------------------------------

const loadingStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--s-2)",
} as const;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="mark">
          <Shield glyph />
        </div>
        {children}
      </div>
    </main>
  );
}

type StepStatus = "pending" | "done" | "skipped";

function StatusPill({
  label,
  connected,
  offLabel = "not connected",
}: {
  label: string;
  connected: boolean;
  offLabel?: string;
}) {
  return (
    <span className={`status-pill ${connected ? "on" : ""}`}>
      <span className={`status-dot ${connected ? "on" : ""}`} />
      {label}: {connected ? "connected" : offLabel}
    </span>
  );
}

function AdvancedInstallSettings({
  open,
  disabled,
  registryEnabled,
  otpEnabled,
  proxyUrl,
  onToggle,
  onRegistryChange,
  onOtpChange,
  onProxyChange,
}: {
  open: boolean;
  disabled: boolean;
  registryEnabled: boolean;
  otpEnabled: boolean;
  proxyUrl: string;
  onToggle: () => void;
  onRegistryChange: (value: boolean) => void;
  onOtpChange: (value: boolean) => void;
  onProxyChange: (value: string) => void;
}) {
  return (
    <section className="install-advanced" aria-label="Advanced install settings">
      <button
        type="button"
        className="advanced-toggle"
        onClick={onToggle}
        disabled={disabled}
      >
        Advanced settings
        <span>{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="advanced-panel">
          <label className="check-row">
            <input
              type="checkbox"
              checked={registryEnabled}
              disabled={disabled}
              onChange={(event) => onRegistryChange(event.currentTarget.checked)}
            />
            <span>
              <b>Managed skill registry</b>
              Reuse shared signup recipes and let successful non-personal recipes improve the registry.
            </span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={otpEnabled}
              disabled={disabled}
              onChange={(event) => onOtpChange(event.currentTarget.checked)}
            />
            <span>
              <b>Email verification polling</b>
              Allow polling only for OTP messages matching services you ask the squire to handle.
            </span>
          </label>
          <label className="field compact">
            <span>Proxy URL</span>
            <input
              value={proxyUrl}
              disabled={disabled}
              placeholder="http://user:pass@host:port or socks5://..."
              onChange={(event) => onProxyChange(event.currentTarget.value)}
            />
          </label>
        </div>
      )}
    </section>
  );
}

function WizardStep({
  number,
  title,
  hint,
  required,
  status,
  disabled,
  children,
}: {
  number: number;
  title: string;
  hint?: string;
  required?: boolean;
  status: StepStatus;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <li className={`wizard-step wizard-step--${status}${disabled ? " wizard-step--disabled" : ""}`}>
      <div className="wizard-step-head">
        <span className="wizard-step-num" aria-hidden="true">
          {status === "done" ? "✓" : status === "skipped" ? "—" : number}
        </span>
        <div className="wizard-step-body">
          <div className="wizard-step-title">
            {title}
            <span className="wizard-step-tag">
              {required ? "Required" : status === "skipped" ? "Skipped" : "Optional"}
            </span>
          </div>
          {hint !== undefined && <div className="wizard-step-hint">{hint}</div>}
        </div>
      </div>
      {children !== undefined && <div className="wizard-step-actions">{children}</div>}
    </li>
  );
}
