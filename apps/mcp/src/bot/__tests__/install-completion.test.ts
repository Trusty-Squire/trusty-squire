import { afterEach, describe, expect, it } from "vitest";
import {
  startInstallCompletionListener,
  withInstallCompletionCallback,
  type InstallCompletionListener,
} from "../install-completion.js";

describe("plain install completion listener", () => {
  let listener: InstallCompletionListener | undefined;

  afterEach(async () => {
    await listener?.close();
    listener = undefined;
  });

  it("acknowledges support before accepting the exact Finish callback", async () => {
    const doneUrl = "https://trustysquire.ai/install/done";
    const confirmUrl = "https://trustysquire.ai/install?token=setup";
    listener = await startInstallCompletionListener(doneUrl, confirmUrl);

    expect(listener.isCompleted()).toBe(false);
    expect(listener.isAcknowledged()).toBe(false);
    const wrong = await fetch(`${listener.callbackUrl}/wrong`, {
      redirect: "manual",
    });
    expect(wrong.status).toBe(404);
    expect(listener.isCompleted()).toBe(false);

    const acknowledged = await fetch(`${listener.callbackUrl}/ack`, {
      redirect: "manual",
    });
    expect(acknowledged.status).toBe(302);
    const acknowledgementRedirect = new URL(
      acknowledged.headers.get("location")!,
    );
    expect(`${acknowledgementRedirect.origin}${acknowledgementRedirect.pathname}${acknowledgementRedirect.search}`).toBe(
      confirmUrl,
    );
    const acknowledgementFragment = new URLSearchParams(
      acknowledgementRedirect.hash.slice(1),
    );
    expect(acknowledgementFragment.get("ts_install_complete")).toBe(
      listener.callbackUrl,
    );
    expect(acknowledgementFragment.get("ts_install_complete_ack")).toBe("1");
    expect(listener.isAcknowledged()).toBe(true);
    expect(listener.isCompleted()).toBe(false);

    const finished = await fetch(listener.callbackUrl, { redirect: "manual" });
    expect(finished.status).toBe(302);
    expect(finished.headers.get("location")).toBe(doneUrl);
    expect(listener.isCompleted()).toBe(true);
  });

  it("carries the callback in the confirm URL fragment, outside request logs", () => {
    const callback = "http://127.0.0.1:45678/.well-known/trusty-squire/install-complete/abc";
    const decorated = withInstallCompletionCallback(
      "https://trustysquire.ai/install?token=setup",
      callback,
    );
    const url = new URL(decorated);

    expect(url.searchParams.get("token")).toBe("setup");
    expect(url.searchParams.has("ts_install_complete")).toBe(false);
    expect(new URLSearchParams(url.hash.slice(1)).get("ts_install_complete")).toBe(callback);
  });
});
