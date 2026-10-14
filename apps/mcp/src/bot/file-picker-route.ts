import type { Frame, Page } from "playwright";

// Some upload controls call window.showOpenFilePicker (File System Access API)
// instead of clicking an <input type=file>. Chromium opens that picker without
// a file input, so Playwright never emits "filechooser" and the upload times
// out. MEASURED 2026-10-14 on Dreamina's "Add first frame" card: one trusted
// click calls showOpenFilePicker with user activation and nothing else.
//
// While an upload is armed, replace showOpenFilePicker in each frame with a
// version that clicks a detached file input instead. The click still runs
// inside the page's activated call, so the existing chooser interception
// receives it, and the page gets back handles whose getFile() returns the
// attached file. The original function is put back once the chooser wait ends.
const ROUTE_KEY = "trusty-squire.file-picker-route";

function installRoute(key: string): boolean {
  const w = window as unknown as Record<string | symbol, unknown>;
  const slot = Symbol.for(key);
  const original = w.showOpenFilePicker;
  if (typeof original !== "function" || w[slot] !== undefined) return false;
  const state = { original, calls: 0 };
  Object.defineProperty(w, slot, { value: state, configurable: true });
  type PickerOptions = {
    multiple?: boolean;
    types?: { accept?: Record<string, string | string[]> }[];
  };
  w.showOpenFilePicker = function showOpenFilePicker(options?: PickerOptions) {
    state.calls += 1;
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = options?.multiple === true;
      input.accept = (options?.types ?? [])
        .flatMap((type) => Object.entries(type?.accept ?? {}))
        .flatMap(([mime, extensions]) => [mime, ...([] as string[]).concat(extensions)])
        .join(",");
      const abort = (): void =>
        reject(new DOMException("The user aborted a request.", "AbortError"));
      input.addEventListener("cancel", abort, { once: true });
      input.addEventListener(
        "change",
        () => {
          const files = Array.from(input.files ?? []);
          if (files.length === 0) return abort();
          resolve(
            files.map((file) => {
              const handle = Object.create(FileSystemFileHandle.prototype) as object;
              Object.defineProperties(handle, {
                kind: { value: "file" },
                name: { value: file.name },
                getFile: { value: async () => file },
              });
              return handle;
            }),
          );
        },
        { once: true },
      );
      input.click();
    });
  };
  return true;
}

function removeRoute(key: string): number {
  const w = window as unknown as Record<string | symbol, unknown>;
  const slot = Symbol.for(key);
  const state = w[slot] as { original: unknown; calls: number } | undefined;
  if (state === undefined) return 0;
  w.showOpenFilePicker = state.original;
  delete w[slot];
  return state.calls;
}

// Patchright runs frame.evaluate in an isolated world unless the third argument
// is false, and the page's own showOpenFilePicker lives in the main world.
// Playwright rejects a third argument and already evaluates in the main world.
async function evaluateInMainWorld<R>(
  frame: Frame,
  fn: (key: string) => R,
  key: string,
): Promise<R> {
  const evaluate = frame.evaluate as unknown as (
    fn: (key: string) => R,
    key: string,
    isolatedContext: boolean,
  ) => Promise<R>;
  try {
    return await evaluate.call(frame, fn, key, false);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Too many arguments"))
      return await frame.evaluate(fn, key);
    throw error;
  }
}

export interface FilePickerRoute {
  // Restores every routed frame and reports whether the page called the picker.
  restore(): Promise<{ pickerCalled: boolean }>;
}

export async function routeFilePickerToChooser(page: Page): Promise<FilePickerRoute> {
  let frames: Frame[] = [];
  try {
    frames = page.frames();
  } catch {
    // A page without frames has no picker to route.
  }
  const routed = (
    await Promise.all(
      frames.map(async (frame) =>
        (await evaluateInMainWorld(frame, installRoute, ROUTE_KEY).catch(() => false))
          ? frame
          : null,
      ),
    )
  ).filter((frame): frame is Frame => frame !== null);
  return {
    async restore() {
      const calls = await Promise.all(
        routed.map((frame) => evaluateInMainWorld(frame, removeRoute, ROUTE_KEY).catch(() => 0)),
      );
      return { pickerCalled: calls.some((count) => count > 0) };
    },
  };
}
