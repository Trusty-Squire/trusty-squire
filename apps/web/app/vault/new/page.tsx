"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { ApiError, apiPost } from "../../lib/api";

// Mirrors packages/vault/src/service-hosts.ts so the page can show the
// derived allowlist live as you type a service.
const KNOWN_HOSTS: Record<string, string[]> = {
  openai: ["api.openai.com"],
  anthropic: ["api.anthropic.com"],
  github: ["api.github.com"],
  stripe: ["api.stripe.com"],
  resend: ["api.resend.com"],
  sentry: ["sentry.io"],
  openrouter: ["openrouter.ai"],
  ipinfo: ["ipinfo.io"],
  postmark: ["api.postmarkapp.com"],
  render: ["api.render.com"],
  vercel: ["api.vercel.com"],
};

function derivedHosts(service: string): string[] {
  const slug = service.toLowerCase().replace(/[^a-z0-9]/g, "");
  return KNOWN_HOSTS[slug] ?? [];
}

interface FieldRow {
  name: string;
  value: string;
}

export default function NewCredentialPage() {
  const router = useRouter();
  const [service, setService] = useState("");
  const [single, setSingle] = useState("");
  const [multi, setMulti] = useState(false);
  const [fields, setFields] = useState<FieldRow[]>([{ name: "", value: "" }]);
  const [advanced, setAdvanced] = useState(false);
  const [label, setLabel] = useState("default");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hosts = useMemo(() => derivedHosts(service), [service]);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (service.trim() === "") return;
      const payload: Record<string, unknown> = { service: service.trim() };
      if (label.trim() !== "" && label.trim() !== "default") payload.label = label.trim();
      if (multi) {
        const map: Record<string, string> = {};
        for (const f of fields) {
          if (f.name.trim() !== "" && f.value !== "") map[f.name.trim()] = f.value;
        }
        if (Object.keys(map).length === 0) {
          setError("Add at least one named field with a value.");
          return;
        }
        payload.fields = map;
      } else {
        if (single === "") return;
        payload.value = single;
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
    [service, label, multi, fields, single, router],
  );

  return (
    <AppShell>
      <div className="app-head">
        <div>
          <h1 className="app-title">New credential</h1>
          <p className="app-sub">
            Encrypted, used only via the proxy, never shown to an agent.
          </p>
        </div>
      </div>

      <form className="form cred-form" onSubmit={submit}>
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
          {service.trim() !== "" && (
            <span className="field-hint">
              {hosts.length > 0
                ? `↳ proxy will allow ${hosts.join(", ")}`
                : "↳ no hosts known — set allowed hosts after saving to enable use_credential"}
            </span>
          )}
        </div>

        {!multi ? (
          <div className="field">
            <label htmlFor="secret">Secret</label>
            <input
              id="secret"
              className="mono"
              type={reveal ? "text" : "password"}
              value={single}
              onChange={(e) => setSingle(e.target.value)}
              placeholder="sk-…"
              autoComplete="off"
              required
            />
            <div className="field-row-actions">
              <button type="button" className="linkbtn" onClick={() => setReveal((r) => !r)}>
                {reveal ? "hide" : "show"}
              </button>
              <button
                type="button"
                className="linkbtn"
                onClick={() => {
                  setMulti(true);
                  setFields(
                    single !== "" ? [{ name: "value", value: single }, { name: "", value: "" }] : [{ name: "", value: "" }],
                  );
                }}
              >
                + Add field
              </button>
            </div>
          </div>
        ) : (
          <div className="field">
            <label>Fields</label>
            {fields.map((f, i) => (
              <div className="field-pair" key={i}>
                <input
                  className="mono field-name"
                  value={f.name}
                  placeholder="access_key_id"
                  autoComplete="off"
                  onChange={(e) =>
                    setFields((prev) => prev.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)))
                  }
                />
                <input
                  className="mono"
                  type="password"
                  value={f.value}
                  placeholder="value"
                  autoComplete="off"
                  onChange={(e) =>
                    setFields((prev) => prev.map((p, j) => (j === i ? { ...p, value: e.target.value } : p)))
                  }
                />
                <button
                  type="button"
                  className="field-remove"
                  aria-label="Remove field"
                  onClick={() => setFields((prev) => prev.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              className="linkbtn"
              onClick={() => setFields((prev) => [...prev, { name: "", value: "" }])}
            >
              + Add field
            </button>
          </div>
        )}

        <button type="button" className="disclose" onClick={() => setAdvanced((a) => !a)}>
          {advanced ? "▾" : "▸"} Advanced
        </button>
        {advanced && (
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
            <span className="field-hint">
              Keeps prod/dev keys for the same service apart. Allowed hosts are
              editable from the vault list after saving.
            </span>
          </div>
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
