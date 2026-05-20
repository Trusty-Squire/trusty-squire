"use client";

import { useState } from "react";

const INSTALL_CMD = "npx @trusty-squire/mcp install";

export function CopyChip() {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="chip"
      aria-label="Copy install command"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(INSTALL_CMD);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch {
          /* clipboard unavailable — no-op */
        }
      }}
    >
      <span className="p">$</span>
      <span>{INSTALL_CMD}</span>
      <span className="c">{copied ? "copied" : "copy"}</span>
    </button>
  );
}
