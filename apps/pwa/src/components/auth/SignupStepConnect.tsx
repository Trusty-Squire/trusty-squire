"use client";

import { useEffect, useState } from "react";
import { clearSignup } from "./signup-state";

const AGENTS = [
  { key: "claude-code", name: "Claude Code" },
  { key: "cursor", name: "Cursor" },
  { key: "goose", name: "Goose" },
  { key: "cline", name: "Cline" },
  { key: "continue", name: "Continue" },
];

export function SignupStepConnect() {
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    clearSignup();
  }, []);

  async function copy(text: string, key: string) {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-[color:var(--color-ink-soft)]">
        Install the Trusty Squire MCP server in your coding agent. Run one of the commands below;
        it will open a browser tab to confirm pairing.
      </p>
      <ul className="space-y-3">
        {AGENTS.map((a) => {
          const cmd = `npx -y @trusty-squire/mcp install --target=${a.key}`;
          return (
            <li
              key={a.key}
              className="flex items-center justify-between gap-4 p-3 rounded-lg bg-[color:var(--color-cream)] border border-[color:var(--color-rule)]"
            >
              <div>
                <p className="font-medium">{a.name}</p>
                <code className="text-xs font-mono text-[color:var(--color-ink-soft)]">{cmd}</code>
              </div>
              <button
                type="button"
                onClick={() => copy(cmd, a.key)}
                className="px-3 py-1.5 text-sm rounded-md border border-[color:var(--color-rule)] bg-white"
              >
                {copied === a.key ? "Copied" : "Copy"}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-sm text-[color:var(--color-ink-soft)]">
        Already paired? <a href="/dashboard">Open the dashboard.</a>
      </p>
    </div>
  );
}
