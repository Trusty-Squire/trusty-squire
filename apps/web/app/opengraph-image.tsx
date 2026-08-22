import { ImageResponse } from "next/og";

export const alt =
  "Trusty Squire empowering an agent with auth and payments, keys and card kept in a write-only vault";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "66px 72px",
        color: "#f4f4f6",
        background: "#08080a",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 26 }}>
        <div
          style={{
            width: 42,
            height: 42,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid rgba(255,255,255,.18)",
            borderRadius: 10,
            color: "#8b89ff",
          }}
        >
          TS
        </div>
        <span style={{ fontWeight: 650 }}>Trusty Squire</span>
        <span style={{ marginLeft: "auto", color: "#8b89ff", fontSize: 18 }}>MCP server</span>
      </div>

      <div style={{ display: "flex", gap: 46, alignItems: "flex-end" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 24, width: 620 }}>
          <div style={{ fontSize: 58, lineHeight: 1.04, letterSpacing: "-0.045em" }}>
            Empower agents with auth and payments.
          </div>
          <div style={{ color: "#9a9aa4", fontSize: 23, lineHeight: 1.45 }}>
            MCP tools to automate auth and pay — your keys and card never leave the vault.
          </div>
        </div>

        <div
          style={{
            width: 390,
            display: "flex",
            flexDirection: "column",
            gap: 15,
            padding: "26px 28px",
            border: "1px solid rgba(255,255,255,.14)",
            borderRadius: 12,
            background: "#0e0e11",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 17,
          }}
        >
          <div style={{ color: "#f4f4f6" }}>$ create a Clerk account</div>
          <div style={{ color: "#9a9aa4" }}>squire · email verification complete</div>
          <div style={{ color: "#54d88b" }}>secret key sealed to vault</div>
          <div style={{ color: "#8b89ff" }}>vault reference · cred_clerk_••••</div>
        </div>
      </div>
    </div>,
    size,
  );
}
