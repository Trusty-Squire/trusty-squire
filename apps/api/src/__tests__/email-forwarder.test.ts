// EmailForwarder — Resend HTTP client behavior.
//
// The class wraps a single POST to api.resend.com/emails. Tests pin
// the HTTP shape (auth header, body fields), the no-key log-only
// path, and the alias-forwarding behavior so a regression of any
// surface immediately fails here instead of silently breaking the
// notify-heightened-auth + inbound-forward paths in prod.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailForwarder, type EmailAlias } from "../services/email-forwarder.js";

const TEST_ALIASES: EmailAlias[] = [
  { from: "hello@trustysquire.com", to: "lunchboxfortwo@gmail.com" },
];

describe("EmailForwarder.sendDirect", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("no-ops cleanly when no API key is configured", async () => {
    const fwd = new EmailForwarder(TEST_ALIASES, {});
    const res = await fwd.sendDirect({
      to: "x@y.com",
      subject: "hi",
      text: "test",
    });
    expect(res).toEqual({ success: false, error: "resend_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs to resend with auth + correct body shape", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const fwd = new EmailForwarder(TEST_ALIASES, { resendApiKey: "re_test" });
    const res = await fwd.sendDirect({
      to: "x@y.com",
      subject: "hi",
      text: "hello world",
    });
    expect(res.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer re_test",
    });
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      from: '"Trusty Squire" <notify@trustysquire.com>',
      to: ["x@y.com"],
      subject: "hi",
      text: "hello world",
    });
  });

  it("respects an overridden from address + name", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const fwd = new EmailForwarder(TEST_ALIASES, {
      resendApiKey: "re_test",
      fromAddress: "alerts@trustysquire.com",
      fromName: "Trusty Squire Alerts",
    });
    await fwd.sendDirect({ to: "x@y.com", subject: "hi", text: "msg" });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.from).toBe('"Trusty Squire Alerts" <alerts@trustysquire.com>');
  });

  it("returns an http-coded error on a Resend 4xx/5xx", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 422, text: async () => "from_not_verified" });
    const fwd = new EmailForwarder(TEST_ALIASES, { resendApiKey: "re_test" });
    const res = await fwd.sendDirect({ to: "x@y.com", subject: "hi", text: "m" });
    expect(res.success).toBe(false);
    expect(res.error).toBe("resend_http_422");
  });

  it("swallows network errors and returns false", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const fwd = new EmailForwarder(TEST_ALIASES, { resendApiKey: "re_test" });
    const res = await fwd.sendDirect({ to: "x@y.com", subject: "hi", text: "m" });
    expect(res.success).toBe(false);
    expect(res.error).toBe("resend_network_error");
  });

  it("substitutes a single-space text body when both text + html are absent", async () => {
    // Resend rejects empty-body sends with 422; the forwarder
    // shouldn't hit that just because a caller omitted both.
    fetchMock.mockResolvedValue({ ok: true });
    const fwd = new EmailForwarder(TEST_ALIASES, { resendApiKey: "re_test" });
    await fwd.sendDirect({ to: "x@y.com", subject: "hi" });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.text).toBe(" ");
  });
});

describe("EmailForwarder.forward (alias-routing)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns no_alias_match for an unmapped alias", async () => {
    const fwd = new EmailForwarder(TEST_ALIASES, { resendApiKey: "re_test" });
    const res = await fwd.forward({
      from: "boss@example.com",
      to: "unmapped@trustysquire.com",
      subject: "hi",
      text: "body",
    });
    expect(res).toEqual({ success: false, error: "no_alias_match" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards to the mapped address with subject tag + reply-to", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const fwd = new EmailForwarder(TEST_ALIASES, { resendApiKey: "re_test" });
    await fwd.forward({
      from: "boss@example.com",
      to: "hello@trustysquire.com",
      subject: "Re: project",
      text: "thx",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.from).toBe('"hello@trustysquire.com" <notify@trustysquire.com>');
    expect(body.to).toEqual(["lunchboxfortwo@gmail.com"]);
    expect(body.reply_to).toBe("boss@example.com");
    expect(body.subject).toBe("[hello@trustysquire.com] Re: project");
  });

  it("alias lookup is case-insensitive", async () => {
    const fwd = new EmailForwarder(TEST_ALIASES, { resendApiKey: "re_test" });
    expect(fwd.shouldForward("HELLO@TrustySquire.com")).toBe(true);
    expect(fwd.getForwardAddress("HELLO@TrustySquire.com")).toBe(
      "lunchboxfortwo@gmail.com",
    );
  });
});
