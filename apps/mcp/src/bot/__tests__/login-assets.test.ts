// T8 — static verification of the bundled login assets.
//
// The live VNC connection through vnc.html cannot run in CI (no
// display, no Xvfb rig — see RELEASING.md for the per-release manual
// smoke). What CI CAN guard is that the bundled page stays structurally
// sound: it embeds the password param, imports only noVNC's stable RFB
// module, and the interstitial keeps its substitution placeholders. A
// refactor that breaks any of these would otherwise ship green and only
// fail for a real headless user.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function asset(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../assets/login/${name}`, import.meta.url)),
    "utf8",
  );
}

describe("bundled login asset — vnc.html", () => {
  const html = asset("vnc.html");

  it("is a well-formed HTML document", () => {
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain("</html>");
  });

  it("imports noVNC's stable RFB core module", () => {
    // rfb.js is the one ESM entry point whose API (the RFB
    // constructor + scaleViewport/resizeSession + the
    // connect/disconnect/securityfailure events) is stable across
    // every noVNC 1.x release — see the comment in vnc.html.
    expect(html).toContain('import RFB from "./core/rfb.js"');
  });

  it("uses only the stable RFB API surface", () => {
    expect(html).toContain("new RFB(");
    expect(html).toContain("scaleViewport");
    for (const event of ["connect", "disconnect", "securityfailure"]) {
      expect(html).toContain(`addEventListener("${event}"`);
    }
  });

  it("reads the VNC password from the URL fragment, never the query string", () => {
    // A fragment (#password=) is not sent to the server — keeps the
    // secret out of cloudflared/proxy logs. The query string would not.
    expect(html).toContain("location.hash");
    expect(html).not.toContain("location.search");
    expect(html).toContain('params.get("password")');
    expect(html).toContain("credentials: { password }");
  });
});

describe("bundled login asset — interstitial.html", () => {
  const html = asset("interstitial.html");

  it("is a well-formed HTML document", () => {
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain("</html>");
  });

  it("keeps the {{PROVIDER}} and {{URL}} substitution placeholders", () => {
    expect(html).toContain("{{PROVIDER}}");
    expect(html).toContain("{{URL}}");
    // The Continue button's href is the substituted target URL.
    expect(html).toContain('href="{{URL}}"');
  });
});
