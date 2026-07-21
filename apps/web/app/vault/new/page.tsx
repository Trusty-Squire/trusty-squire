"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { CredentialFields, type FieldsResult } from "../../components/CredentialFields";
import { deriveLoginTarget, parseHostList } from "../../lib/hosts";
import { ApiError, apiPost } from "../../lib/api";

type Kind = "api_key" | "login";

export default function NewCredentialPage() {
  const router = useRouter();
  // What kind of credential — an API key spent through the use_credential
  // proxy, or a website login (id + password) browser-filled on sign-in hosts.
  // Different storage (auth_strategy) and host semantics (allowed_hosts vs
  // login_hosts), so the form reshapes rather than piling both onto one page.
  const [kind, setKind] = useState<Kind>("api_key");
  const [service, setService] = useState("");
  // API-key secret/fields — owned by the shared editor, surfaced here.
  const [fields, setFields] = useState<FieldsResult>({ map: null, error: null });
  // Website-login inputs.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  // One field for a login: the website (sign-in URL or host). It names the
  // credential (service), becomes the required login host, and — when a full
  // URL is pasted — the signin_url. Collapses what used to be Service + Sign-in
  // URL + Sign-in hosts into a single question. The rare multi-host case (fill
  // on a different subdomain) is handled by editing the credential afterward.
  const [website, setWebsite] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [label, setLabel] = useState("default");
  const [allowedHosts, setAllowedHosts] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const payload: Record<string, unknown> = {};
      if (label.trim() !== "" && label.trim() !== "default") payload.label = label.trim();

      if (kind === "login") {
        // Website login: id + password, browser-filled on sign-in hosts. Sent
        // as auth_strategy=username_password (browser-fill only, never proxied);
        // canonical field names { login, password } match the seal default.
        if (username.trim() === "" || password === "") {
          setError("Enter both an email/username and a password.");
          return;
        }
        const { host, signinUrl } = deriveLoginTarget(website);
        if (host === null) {
          setError("Enter the website — its sign-in URL or host (e.g. clubgg.com).");
          return;
        }
        // The site IS a login's identity — derive the service from it instead
        // of asking for the same fact twice.
        payload.service = host;
        payload.auth_strategy = "username_password";
        payload.fields = { login: username.trim(), password };
        payload.login_hosts = [host];
        if (signinUrl !== undefined) payload.signin_url = signinUrl;
      } else {
        // API key: spent through the use_credential proxy. Explicit hosts →
        // observed_hosts, unioned server-side into the allowlist.
        if (service.trim() === "") return;
        payload.service = service.trim();
        if (fields.map === null) {
          setError(fields.error ?? "Add a secret, or at least one field with a value.");
          return;
        }
        const map = fields.map;
        if (Object.keys(map).length === 1 && "value" in map) payload.value = map.value;
        else payload.fields = map;
        const hosts = parseHostList(allowedHosts);
        if (hosts.length > 0) payload.observed_hosts = hosts;
      }

      setBusy(true);
      setError(null);
      try {
        await apiPost("/v1/vault/credentials/manual", payload);
        router.push("/vault");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login?next=/vault/new");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to save.");
        setBusy(false);
      }
    },
    [kind, service, label, allowedHosts, fields, username, password, website, router],
  );

  return (
    <AppShell>
      <div className="app-head">
        <div>
          <h1 className="app-title">New credential</h1>
          <p className="app-sub">
            {kind === "login"
              ? "Encrypted; filled into sign-in pages for you, never shown to an agent."
              : "Encrypted, used only via the proxy, never shown to an agent."}
          </p>
        </div>
      </div>

      <form className="form cred-form" onSubmit={submit}>
        <div className="seg" role="group" aria-label="Credential kind">
          <button type="button" aria-pressed={kind === "api_key"} onClick={() => setKind("api_key")}>
            API key
          </button>
          <button type="button" aria-pressed={kind === "login"} onClick={() => setKind("login")}>
            Website login
          </button>
        </div>

        {kind === "login" ? (
          <>
            <div className="field">
              <label htmlFor="login-website">Website</label>
              <input
                id="login-website"
                className="mono"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="clubgg.com"
                autoComplete="off"
                required
              />
              <span className="field-hint">
                The site this login is for — its name in your vault and the only
                place Trusty Squire fills it. Paste the full sign-in URL
                (https://…/login) to also pin the exact page.
              </span>
            </div>
            <div className="field">
              <label htmlFor="login-username">Email or username</label>
              <input
                id="login-username"
                className="mono"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="me@example.com"
                autoComplete="off"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="login-password">Password</label>
              <input
                id="login-password"
                className="mono"
                type={reveal ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="off"
                required
              />
              <div className="field-row-actions">
                <button type="button" className="linkbtn" onClick={() => setReveal((r) => !r)}>
                  {reveal ? "hide" : "show"}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="service">Service</label>
              <input
                id="service"
                value={service}
                onChange={(e) => setService(e.target.value)}
                placeholder="OpenAI"
                autoComplete="off"
                required
              />
            </div>
            <CredentialFields idPrefix="new" onChange={setFields} />
          </>
        )}

        <button type="button" className="disclose" onClick={() => setAdvanced((a) => !a)}>
          {advanced ? "▾" : "▸"} Advanced
        </button>
        {advanced && (
          <>
            <div className="field">
              <label htmlFor="label">Label</label>
              <input
                id="label"
                className="mono"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="default"
                autoComplete="off"
              />
              <span className="field-hint">Keeps prod/dev entries for the same service apart.</span>
            </div>
            {kind === "api_key" && (
              <div className="field">
                <label htmlFor="allowed-hosts">Allowed hosts</label>
                <textarea
                  id="allowed-hosts"
                  className="mono"
                  value={allowedHosts}
                  onChange={(e) => setAllowedHosts(e.target.value)}
                  placeholder="api.example.com"
                  rows={3}
                  autoComplete="off"
                />
                <span className="field-hint">
                  Hosts use_credential may call. One per line. Leave blank for known
                  services (their API hosts are filled in automatically).
                </span>
              </div>
            )}
          </>
        )}

        {error !== null && <div className="form-err">{error}</div>}

        <div className="form-actions">
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button className="btn-secondary" type="button" onClick={() => router.push("/vault")}>
            Cancel
          </button>
        </div>
      </form>
    </AppShell>
  );
}
