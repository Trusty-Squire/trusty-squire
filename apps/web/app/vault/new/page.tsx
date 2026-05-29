"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { ApiError, apiPost } from "../../lib/api";

const TYPES = [
  "api_key",
  "oauth_token",
  "username_password",
  "session_cookie",
  "secret",
  "totp_seed",
  "sso_metadata",
] as const;

export default function NewCredentialPage() {
  const router = useRouter();
  const [service, setService] = useState("");
  const [value, setValue] = useState("");
  const [envVar, setEnvVar] = useState("");
  const [type, setType] = useState<(typeof TYPES)[number]>("api_key");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (service.trim() === "" || value.trim() === "") return;
      setBusy(true);
      setError(null);
      try {
        await apiPost("/v1/vault/credentials/manual", {
          service: service.trim(),
          value,
          type,
          ...(envVar.trim() !== "" ? { env_var_suggestion: envVar.trim() } : {}),
        });
        router.push("/vault");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login?next=/vault/new");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to save the key.");
        setBusy(false);
      }
    },
    [service, value, type, envVar, router],
  );

  return (
    <AppShell>
      <div className="app-head">
        <div>
          <h1 className="app-title">Add a key</h1>
          <p className="app-sub">
            Paste a secret to store it in the vault. It&apos;s encrypted at rest
            and never shown to an agent unless you approve.
          </p>
        </div>
      </div>

      <form className="form" onSubmit={submit}>
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
          <span className="field-hint">
            Used to seed the proxy&apos;s allowed-hosts (e.g. OpenAI →
            api.openai.com). You can edit hosts later.
          </span>
        </div>

        <div className="field">
          <label htmlFor="value">Secret value</label>
          <input
            id="value"
            className="mono"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="sk-…"
            autoComplete="off"
            type="password"
            required
          />
        </div>

        <div className="field">
          <label htmlFor="envvar">Env var name (optional)</label>
          <input
            id="envvar"
            className="mono"
            value={envVar}
            onChange={(e) => setEnvVar(e.target.value)}
            placeholder="OPENAI_API_KEY"
            autoComplete="off"
          />
        </div>

        <div className="field">
          <label htmlFor="type">Type</label>
          <select
            id="type"
            value={type}
            onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        {error !== null && <div className="form-err">{error}</div>}

        <div className="form-actions">
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save to vault"}
          </button>
          <button
            className="btn-secondary"
            type="button"
            onClick={() => router.push("/vault")}
          >
            Cancel
          </button>
        </div>
      </form>
    </AppShell>
  );
}
