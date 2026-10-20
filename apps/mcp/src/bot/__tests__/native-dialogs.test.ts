import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { NativeDialogs } from "../native-dialogs.js";

function fixture() {
  const page = new EventEmitter();
  const dialogs = new NativeDialogs(100);
  dialogs.watch(page);
  const handle = {
    type: () => "prompt",
    message: () => "Continue?",
    defaultValue: () => "Ada",
    accept: vi.fn(async (_text?: string) => undefined),
    dismiss: vi.fn(async () => undefined),
  };
  return { page, dialogs, handle, open: () => page.emit("dialog", handle) };
}
afterEach(() => vi.useRealTimers());

it("does not accept on open, requires prompt text only on accept, and consumes an answer once", async () => {
  const { dialogs, handle, open } = fixture();
  open();
  const id = dialogs.evidence()[0]!.id;
  expect(handle.accept).not.toHaveBeenCalled();
  await expect(dialogs.answer(id, "dismiss", "text")).rejects.toThrow(
    "prompt_text_requires_prompt_accept",
  );
  expect(dialogs.blocked).toBe(true);
  await dialogs.answer(id, "accept", "Grace");
  expect(handle.accept).toHaveBeenCalledWith("Grace");
  await expect(dialogs.answer(id, "dismiss")).rejects.toThrow("stale_native_dialog");
  await dialogs.dispose();
});

it("releases a blocked dispatch to the caller and rejects additional page actions", async () => {
  const { dialogs, open } = fixture();
  let release!: () => void;
  const running = new Promise<void>((resolve) => {
    release = resolve;
  });
  await dialogs.interrupt(async () => {
    open();
    await running;
  });
  await expect(dialogs.interrupt(async () => undefined)).rejects.toThrow("native_dialog_pending");
  await dialogs.answer(dialogs.evidence()[0]!.id, "dismiss");
  release();
  await dialogs.dispose();
});

it("dismisses after the bound, reports the timeout, and removes closed-page state", async () => {
  vi.useFakeTimers();
  const { page, dialogs, handle, open } = fixture();
  open();
  await vi.advanceTimersByTimeAsync(100);
  expect(handle.dismiss).toHaveBeenCalledTimes(1);
  expect(dialogs.timeoutNotices()[0]).toContain("dismissed after timeout");
  expect(handle.accept).not.toHaveBeenCalled();
  open();
  page.emit("close");
  expect(dialogs.blocked).toBe(false);
  expect(page.listenerCount("dialog")).toBe(0);
  await vi.advanceTimersByTimeAsync(100);
  expect(handle.dismiss).toHaveBeenCalledTimes(1);
});

it("session disposal dismisses pending dialogs and removes listeners", async () => {
  const { page, dialogs, handle, open } = fixture();
  open();
  await dialogs.dispose();
  expect(handle.dismiss).toHaveBeenCalledTimes(1);
  expect(page.listenerCount("dialog")).toBe(0);
  expect(dialogs.blocked).toBe(false);
});

it("returns browser evidence when a dialog arrives during an in-flight DOM read", async () => {
  const { dialogs, open } = fixture();
  let complete!: (value: string) => void;
  const rawRead = new Promise<string>((resolve) => {
    complete = resolve;
  });
  const observation = dialogs.read(
    () => rawRead,
    () => dialogs.evidence()[0]!.text,
  );
  open();
  expect(await observation).toBe("Continue?");
  await dialogs.answer(dialogs.evidence()[0]!.id, "dismiss");
  complete("page text");
  await dialogs.dispose();
});
