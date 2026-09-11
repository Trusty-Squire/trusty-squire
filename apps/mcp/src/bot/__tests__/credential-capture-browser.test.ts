import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import * as lifecycle from "../session/lifecycle.js";
import { captureCredentialSource, probeCaptureSource } from "../provision-session.js";
import type { Session } from "../session/model.js";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  page = await browser.newPage();
  vi.spyOn(lifecycle, "sessionForCall").mockReturnValue({
    browser: { activePage: () => page, waitForInteractiveDom: async () => undefined },
  } as unknown as Session);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await browser?.close();
});

it("captures only one visible source in the explicit container without clicking reveal", async () => {
  await page.setContent(`<input aria-label="API key" value="unrelated-fixture"><dialog open aria-label="Created key">
    <button onclick="document.body.dataset.clicked='yes'">Reveal unrelated key</button>
    <input aria-label="API key" value="fresh-fixture-value"></dialog>`);
  const captured = await captureCredentialSource("fixture", {
    role: "textbox",
    name: "API key",
    container: { role: "dialog", name: "Created key" },
  });
  expect(captured).toMatchObject({ candidate_count: 1, value: "fresh-fixture-value" });
  expect(await page.locator("body").getAttribute("data-clicked")).toBeNull();
  expect(await captureCredentialSource("fixture", { role: "textbox", name: "API key" })).toEqual({
    candidate_count: 2,
  });
});

it.each(["role", "selector"] as const)(
  "never retargets a matching %s source in a replacement document",
  async (kind) => {
    await page.setContent('<input aria-label="API key" value="original-fixture">');
    const locator = page.getByRole("textbox", { name: "API key", exact: true });
    const originalHandles = locator.elementHandles.bind(locator);
    vi.spyOn(locator, "elementHandles").mockImplementation(async () => {
      const handles = await originalHandles();
      await page.goto('data:text/html,<input aria-label="API key" value="replacement-fixture">');
      return handles;
    });
    const lookup =
      kind === "role"
        ? vi.spyOn(page, "getByRole").mockReturnValue(locator)
        : vi.spyOn(page, "locator").mockReturnValue(locator);
    const filter = vi.spyOn(locator, "filter").mockReturnValue(locator);
    try {
      await expect(
        captureCredentialSource(
          "fixture",
          kind === "role" ? { role: "textbox", name: "API key" } : { selector: "input" },
        ),
      ).rejects.toThrow();
    } finally {
      lookup.mockRestore();
      filter.mockRestore();
    }
    expect(await page.getByRole("textbox").inputValue()).toBe("replacement-fixture");
  },
);

it("captures the settled plain-text copy field reported on Neon", async () => {
  const value = "synthetic-neon-token-not-a-real-key";
  await page.setContent(`<section role="dialog">
    <div><div><label>API token</label><div><div><div><div>${value}</div></div></div>
      <div><div><button onclick="document.body.dataset.copied='yes'">Copy</button></div></div>
    </div></div></div><button>Copy and close</button>
  </section>`);
  // Firstmate confirmed the real token is a visible DIV, without an input/code
  // ancestor. Only the reported label/value grouping is represented; no
  // production classes, IDs, or token content are used to locate the value.
  const selector = 'label:text-is("API token") + div div:not(:has(*))';
  expect(await captureCredentialSource("fixture", { role: "textbox" })).toMatchObject({
    candidate_count: 0,
  });
  expect(await captureCredentialSource("fixture", { role: "code" })).toMatchObject({
    candidate_count: 0,
  });
  expect(
    await captureCredentialSource("fixture", {
      selector,
      container: { role: "dialog" },
    }),
  ).toMatchObject({ candidate_count: 1, value });
  expect(await page.locator("body").getAttribute("data-copied")).toBeNull();

  // One-variable counterfactual: only the value-bearing element becomes an
  // input. The unchanged textbox source now works (the proven Resend path).
  await page.locator(selector).evaluate((node) => {
    const input = document.createElement("input");
    input.value = node.textContent!;
    node.replaceWith(input);
  });
  expect(await captureCredentialSource("fixture", { role: "textbox" })).toMatchObject({
    candidate_count: 1,
    value,
  });
});

it("captures the id-less Groq-style key input inside an open shadow root", async () => {
  // Exact live shape (2026-09-11 Groq new-key dialog): an <input value=…>
  // inside an OPEN shadow root with no id, class, type, or readonly attribute.
  const value = "gsk_fixture_key_value_0123456789";
  await page.setContent(`<div id="host"></div>
    <script>
      document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
        '<input value="${value}">';
    </script>`);
  // role textbox: the id-less typeless input is the only textbox on the page.
  expect(await captureCredentialSource("fixture", { role: "textbox" })).toEqual({
    candidate_count: 1,
    value,
  });
  // selector "input": pierces the open shadow root.
  expect(await captureCredentialSource("fixture", { selector: "input" })).toEqual({
    candidate_count: 1,
    value,
  });
});

it.each(["text", "password"])("does not substitute a %s input for another role", async (type) => {
  await page.setContent('<div id="host"></div>');
  await page.locator("#host").evaluate((host, inputType) => {
    host.attachShadow({ mode: "open" }).innerHTML =
      '<input type="' + inputType + '" value="gsk_fixture_key_value_0123456789">';
  }, type);
  expect(await captureCredentialSource("fixture", { role: "code" })).toMatchObject({
    candidate_count: 0,
    found: [{ role: type === "text" ? "textbox" : "input", name: null }],
  });
  if (type === "password")
    expect(await captureCredentialSource("fixture", { role: "textbox" })).toMatchObject({
      candidate_count: 0,
    });
});

it("walks an id-less textbox when the role engine misses", async () => {
  await page.setContent('<div id="host"></div>');
  await page.locator("#host").evaluate((host) => {
    host.attachShadow({ mode: "open" }).innerHTML =
      '<input value="gsk_fixture_key_value_0123456789">';
  });
  const locator = page.getByRole("textbox");
  vi.spyOn(locator, "elementHandles").mockResolvedValue([]);
  const lookup = vi.spyOn(page, "getByRole").mockReturnValue(locator);
  try {
    expect(await captureCredentialSource("fixture", { role: "textbox" })).toEqual({
      candidate_count: 1,
      value: "gsk_fixture_key_value_0123456789",
    });
  } finally {
    lookup.mockRestore();
  }
});

it.each([
  '[role=dialog] input',
  '[role=dialog] > section > input',
  '[role=dialog] section label + input',
  '[role=dialog] section label ~ input',
  '[data-caption="a > b, c"] input:not([type="password"])',
  '.missing, [role=dialog] input',
])("walks cross-shadow combinators for %s when the CSS engine misses", async (selector) => {
  await page.setContent('<div role="dialog" data-caption="a > b, c" id="host"></div>');
  await page.locator("#host").evaluate((host) => {
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<section><label>Created key</label><input value="shadow-fixture"></section>';
  });
  const locator = page.locator(selector);
  vi.spyOn(locator, "elementHandles").mockResolvedValue([]);
  vi.spyOn(locator, "filter").mockReturnValue(locator);
  const lookup = vi.spyOn(page, "locator").mockReturnValue(locator);
  try {
    expect(await captureCredentialSource("fixture", { selector })).toEqual({
      candidate_count: 1,
      value: "shadow-fixture",
    });
    expect(await captureCredentialSource("fixture", { selector: '[role=region] input' }))
      .toMatchObject({ candidate_count: 0 });
  } finally {
    lookup.mockRestore();
  }
});

it("keeps the fallback scoped to a container inside a shadow root", async () => {
  await page.setContent('<div id="host"></div>');
  await page.locator("#host").evaluate((host) => {
    host.attachShadow({ mode: "open" }).innerHTML =
      '<input value="outside-fixture"><section role="dialog"><div><input value="inside-fixture"></div></section>';
  });
  const locator = page.getByRole("dialog");
  vi.spyOn(locator, "elementHandles").mockResolvedValue([]);
  vi.spyOn(locator, "getByRole").mockReturnValue(locator);
  const lookup = vi.spyOn(page, "getByRole").mockReturnValue(locator);
  try {
    expect(await captureCredentialSource("fixture", {
      role: "textbox",
      container: { role: "dialog" },
    })).toEqual({ candidate_count: 1, value: "inside-fixture" });
  } finally {
    lookup.mockRestore();
  }
});

it("preserves diagnostics when a Playwright-only selector matches nothing", async () => {
  await page.setContent('<input aria-label="API key" value="private-fixture">');
  expect(await captureCredentialSource("fixture", { selector: 'label:text-is("Missing")' }))
    .toEqual({ candidate_count: 0, found: [{ role: "textbox", name: "API key" }] });
  await page.setContent("");
  expect(await captureCredentialSource("fixture", { selector: 'label:text-is("Missing")' }))
    .toEqual({ candidate_count: 0, found: [] });
});

it("disposes every acquired handle after an ambiguous capture", async () => {
  await page.setContent('<input value="first-fixture"><input value="second-fixture">');
  const locator = page.getByRole("textbox");
  const handles = await locator.elementHandles();
  const disposals = handles.map((handle) => vi.spyOn(handle, "dispose"));
  vi.spyOn(locator, "elementHandles").mockResolvedValue(handles);
  const lookup = vi.spyOn(page, "getByRole").mockReturnValue(locator);
  try {
    expect(await captureCredentialSource("fixture", { role: "textbox" }))
      .toEqual({ candidate_count: 2 });
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce();
  } finally {
    lookup.mockRestore();
    await Promise.all(handles.map((handle) => handle.dispose()));
  }
});

it("never resolves when several shadow-hosted secret-shaped inputs compete", async () => {
  const secret = "gsk_fixture_key_value_0123456789";
  await page.setContent(`<div id="host-a"></div><div id="host-b"></div>
    <script>
      document.getElementById('host-a').attachShadow({ mode: 'open' }).innerHTML =
        '<input value="${secret}">';
      document.getElementById('host-b').attachShadow({ mode: 'open' }).innerHTML =
        '<input value="${secret}-2">';
    </script>`);
  expect(await captureCredentialSource("fixture", { role: "textbox" })).toEqual({
    candidate_count: 2,
  });
});

it("reports what a zero-match source DID find without exposing values", async () => {
  await page.setContent(`<dialog open aria-label="Created key">
    <input aria-label="API key" value="fresh-fixture-value"></dialog>`);
  const result = await captureCredentialSource("fixture", {
    role: "textbox",
    name: "Signed key",
  });
  expect(result.candidate_count).toBe(0);
  expect(result.found).toEqual([
    { role: "dialog", name: "Created key" },
    { role: "textbox", name: "API key" },
  ]);
  expect(JSON.stringify(result)).not.toContain("fresh-fixture-value");
});

it("never captures outside a demanded container that did not render", async () => {
  await page.setContent(`<input aria-label="API key" value="outside-fixture-value">`);
  expect(
    await captureCredentialSource("fixture", {
      role: "textbox",
      name: "API key",
      container: { role: "dialog" },
    }),
  ).toEqual({
    candidate_count: 0,
    found: [{ role: "textbox", name: "API key" }],
  });
});

it("keeps explicit plain-text sources scoped, visible, and unambiguous", async () => {
  await page.setContent(`<div class="copy-value">outside-fixture</div>
    <section role="dialog"><div class="copy-value" hidden>hidden-fixture</div>
    <div class="copy-value">inside-fixture</div></section>`);
  const source = { selector: ".copy-value", container: { role: "dialog" as const } };
  expect(await captureCredentialSource("fixture", source)).toMatchObject({
    candidate_count: 1,
    value: "inside-fixture",
  });
  expect(await captureCredentialSource("fixture", { selector: ".copy-value" })).toEqual({
    candidate_count: 2,
  });
  await page.locator("section").evaluate((node) => {
    const other = document.createElement("div");
    other.className = "copy-value";
    other.textContent = "another-fixture";
    node.append(other);
  });
  expect(await captureCredentialSource("fixture", source)).toEqual({ candidate_count: 2 });
});

// Groq key-creation shape: the click's mutation renders the created-key dialog
// ASYNCHRONOUSLY, so the capture must judge the POST-action document, never
// re-vault the pre-click textbox.
it("captures the key textbox that only renders after the click's mutation settles", async () => {
  await page.setContent(
    '<input aria-label="Display name" value="My key display name"><button>Create key</button>',
  );
  const source = { role: "textbox" as const };
  const pre = await probeCaptureSource("fixture", source);
  expect(pre.candidate_count).toBe(1);
  expect(pre.value).toBe("My key display name");
  try {
    await page.evaluate(() =>
      setTimeout(() => {
        document.body.innerHTML =
          '<section role="dialog"><input aria-label="API key" value="gsk_fixture_created-key-value"></section>';
      }, 400),
    );
    expect(await captureCredentialSource("fixture", source, { pre })).toEqual({
      candidate_count: 1,
      value: "gsk_fixture_created-key-value",
      resolved_source: { tag: "input", role: "textbox", name: "API key" },
      resolved_from: "post_action",
    });
  } finally {
    await pre.handle?.dispose();
  }
});

it("treats a capture that still resolves only as before the click as unresolved", async () => {
  await page.setContent('<input aria-label="Display name" value="My key display name">');
  const source = { role: "textbox" as const };
  const pre = await probeCaptureSource("fixture", source);
  try {
    const captured = await captureCredentialSource("fixture", source, { pre });
    expect(captured).toEqual({ candidate_count: 1, resolved_from: "pre_action_only" });
    expect(captured.value).toBeUndefined();
  } finally {
    await pre.handle?.dispose();
  }
});

it("still captures when the click reveals a new value in the same element", async () => {
  await page.setContent('<input aria-label="API key" value="masked-fixture">');
  const source = { role: "textbox" as const, name: "API key" as const };
  const pre = await probeCaptureSource("fixture", source);
  expect(pre.value).toBe("masked-fixture");
  try {
    await page.evaluate(() =>
      setTimeout(() => {
        (document.querySelector("input") as HTMLInputElement).value = "gsk_fixture_revealed";
      }, 400),
    );
    expect(await captureCredentialSource("fixture", source, { pre })).toEqual({
      candidate_count: 1,
      value: "gsk_fixture_revealed",
      resolved_source: { tag: "input", role: "textbox", name: "API key" },
      resolved_from: "post_action",
    });
  } finally {
    await pre.handle?.dispose();
  }
});

it("never vaults the pre-click textbox when the dialog adds a second candidate", async () => {
  await page.setContent('<input aria-label="Display name" value="My key display name">');
  const source = { role: "textbox" as const };
  const pre = await probeCaptureSource("fixture", source);
  try {
    await page.evaluate(() =>
      setTimeout(() => {
        const dialog = document.createElement("section");
        dialog.setAttribute("role", "dialog");
        dialog.innerHTML = '<input aria-label="API key" value="gsk_fixture_created">';
        document.body.append(dialog);
      }, 400),
    );
    const captured = await captureCredentialSource("fixture", source, { pre });
    expect(captured).toEqual({ candidate_count: 2, resolved_from: "post_action" });
    expect(captured.value).toBeUndefined();
  } finally {
    await pre.handle?.dispose();
  }
});

it("leaves capture unresolved when a detached source prevented the pre-action probe", async () => {
  await page.setContent('<input aria-label="Display name" value="My key display name">');
  const source = { role: "textbox" as const };
  const locator = page.getByRole("textbox");
  const originalHandles = locator.elementHandles.bind(locator);
  vi.spyOn(locator, "elementHandles").mockImplementation(async () => {
    const handles = await originalHandles();
    await page.locator("input").evaluate((node) => node.replaceWith(node.cloneNode(true)));
    return handles;
  });
  const lookup = vi.spyOn(page, "getByRole").mockReturnValue(locator);
  try {
    await expect(probeCaptureSource("fixture", source)).rejects.toThrow();
  } finally {
    lookup.mockRestore();
  }
  expect(await captureCredentialSource("fixture", source, {})).toEqual({
    candidate_count: 0,
    resolved_from: "pre_action_only",
  });
  expect(await captureCredentialSource("fixture", source)).toMatchObject({
    candidate_count: 1,
    value: "My key display name",
  });
});

it.each([
  '<span id="key-label">API key</span><input aria-labelledby="key-label">',
  '<label for="key">API key</label><input id="key">',
])("names the pinned source from its label", async (html) => {
  await page.setContent(html);
  await page.locator("input").fill("fixture-value");
  expect(await captureCredentialSource("fixture", { role: "textbox" })).toMatchObject({
    value: "fixture-value",
    resolved_source: { tag: "input", role: "textbox", name: "API key" },
  });
});

it("counts shadow candidates even when the selector engine returns one light-DOM match", async () => {
  await page.setContent('<section role="dialog"><input id="light" value="light-fixture"><div id="host"></div></section>');
  await page.locator("#host").evaluate((host) => {
    host.attachShadow({ mode: "open" }).innerHTML = '<input value="shadow-fixture">';
  });
  const locator = page.locator("#light");
  const handles = await locator.elementHandles();
  const disposal = vi.spyOn(handles[0]!, "dispose");
  vi.spyOn(locator, "elementHandles").mockResolvedValue(handles);
  vi.spyOn(locator, "filter").mockReturnValue(locator);
  const lookup = vi.spyOn(page, "locator").mockReturnValue(locator);
  try {
    expect(await captureCredentialSource("fixture", { selector: "[role=dialog] input" }))
      .toEqual({ candidate_count: 2 });
    expect(disposal).toHaveBeenCalledOnce();
  } finally {
    lookup.mockRestore();
  }
});

it.each(["for", "aria-labelledby"])("resolves %s names within the source's owning root", async (association) => {
  await page.setContent('<label id="name" for="key">Old key</label><div id="host"></div>');
  await page.locator("#host").evaluate((host, kind) => {
    host.attachShadow({ mode: "open" }).innerHTML =
      '<label id="name" for="key">New key</label><input id="key" ' +
      (kind === "aria-labelledby" ? 'aria-labelledby="name" ' : '') +
      'value="new-key-fixture">';
  }, association);
  const locator = page.getByRole("textbox");
  vi.spyOn(locator, "elementHandles").mockResolvedValue([]);
  const lookup = vi.spyOn(page, "getByRole").mockReturnValue(locator);
  try {
    const miss = await captureCredentialSource("fixture", { role: "textbox", name: "Old key" });
    expect(miss).toEqual({
      candidate_count: 0,
      found: [{ role: "textbox", name: "New key" }],
    });
    expect(await captureCredentialSource("fixture", { role: "textbox", name: "New key" }))
      .toEqual({ candidate_count: 1, value: "new-key-fixture" });
  } finally {
    lookup.mockRestore();
  }
});

it.each([0, 1, 2])("counts %s sources across two matching containers", async (count) => {
  await page.setContent('<section role="dialog" aria-label="First">First</section><section role="dialog" aria-label="Second">Second</section>');
  await page.locator("section").evaluateAll((sections, inputCount) => {
    for (let i = 0; i < inputCount; i++)
      sections[i]!.innerHTML = '<input value="key-fixture">';
  }, count);
  const locator = page.getByRole("dialog");
  vi.spyOn(locator, "elementHandles").mockResolvedValue([]);
  vi.spyOn(locator, "getByRole").mockReturnValue(locator);
  const lookup = vi.spyOn(page, "getByRole").mockReturnValue(locator);
  try {
    const result = await captureCredentialSource("fixture", {
      role: "textbox",
      container: { role: "dialog" },
    });
    expect(result.candidate_count).toBe(count);
    if (count === 0) expect(result.found).toEqual([
      { role: "dialog", name: "First" },
      { role: "dialog", name: "Second" },
    ]);
    if (count === 1) expect(result.value).toBe("key-fixture");
    if (count === 2) expect(result.value).toBeUndefined();
  } finally {
    lookup.mockRestore();
  }
});

it("never captures a searchbox as a textbox", async () => {
  await page.setContent('<div id="host"></div>');
  await page.locator("#host").evaluate((host) => {
    host.attachShadow({ mode: "open" }).innerHTML =
      '<input type="search" aria-label="Find keys" value="search-query-fixture">';
  });
  expect(await captureCredentialSource("fixture", { role: "textbox" })).toEqual({
    candidate_count: 0,
    found: [{ role: "searchbox", name: "Find keys" }],
  });
});
