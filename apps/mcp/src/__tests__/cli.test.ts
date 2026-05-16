// Covers parseArgs — specifically the --proxy-url flag, which bakes a
// residential proxy into the written MCP config's env so the user sets
// it once at install instead of hand-editing config env.

import { describe, expect, it } from "vitest";
import { parseArgs } from "../install/cli.js";

describe("parseArgs --proxy-url", () => {
  it("parses --proxy-url into proxyUrl", () => {
    expect(
      parseArgs(["install", "--proxy-url=socks5://127.0.0.1:1080"]).proxyUrl,
    ).toBe("socks5://127.0.0.1:1080");
  });

  it("leaves proxyUrl undefined when the flag is absent", () => {
    expect(parseArgs(["install"]).proxyUrl).toBeUndefined();
  });

  it("treats an empty --proxy-url= as unset", () => {
    expect(parseArgs(["install", "--proxy-url="]).proxyUrl).toBeUndefined();
  });

  it("parses --proxy-url alongside --target and --pair", () => {
    const a = parseArgs([
      "install",
      "--target=claude-code",
      "--pair",
      "--proxy-url=http://user:pass@host:8080",
    ]);
    expect(a.target).toBe("claude-code");
    expect(a.withPair).toBe(true);
    expect(a.proxyUrl).toBe("http://user:pass@host:8080");
  });
});
