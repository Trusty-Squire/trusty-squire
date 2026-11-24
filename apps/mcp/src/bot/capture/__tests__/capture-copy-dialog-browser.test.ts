import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { chromium, type BrowserContext, type Page } from "playwright";
import { BrowserController } from "../../browser.js";
import * as lifecycle from "../../session/lifecycle.js";
import type { Session } from "../../session/model.js";
import { copySourceClick, extractCredentials } from "../capture.js";

let profile: string;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  // This fixture uses an isolated persistent profile and never touches the
  // broker's live profile.
  profile = await mkdtemp(join(process.cwd(), ".capture-copy-profile-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  page = context.pages()[0] ?? (await context.newPage());
  const controller = BrowserController.fromHarnessPage(page);
  vi.spyOn(lifecycle, "sessionForCall").mockReturnValue({ browser: controller } as Session);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await context?.close();
  if (profile !== undefined) await rm(profile, { recursive: true, force: true });
});

it.each([
  ["presentation with aria-modal", 'role="presentation" aria-modal="true"'],
  ["unmarked covering layer", ""],
])("copies a generated key from a %s in Chrome", async (_name, attributes) => {
  const key =
    "fixture_Ab9Cd8Ef7Gh6Jk5Lm4Np3Qr2St1Uv0Wx9Yz8Ab7Cd6Ef5Gh4Jk3Lm2Np" +
    (attributes.length > 0 ? "1" : "2");
  await context.clearPermissions();
  const html = `<!doctype html><style>
    body { margin: 0; }
    #background { position: absolute; top: 45%; left: 45%; }
    #cover { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: grid; place-items: center; }
    #card { background: white; padding: 24px; }
    #value::after { content: attr(data-key); }
  </style>
  <button id="background">API key settings</button>
  <div id="cover"><section id="card" ${attributes}>
    <h2>API key generated</h2><div>Key: ********-****-****</div>
    <span id="value" data-key="${key}" style="display:none"></span>
    <button type="button" data-testid="clipboard-action" aria-label="Copy API key">Copy</button>
    <button type="button">Close</button>
  </section></div>
  <script>document.querySelector('[data-testid="clipboard-action"]')
    .addEventListener('click', () => navigator.clipboard.writeText('${key}'));</script>`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://127.0.0.1/");
  const before = await page.evaluate(
    async () =>
      (await navigator.permissions.query({ name: "clipboard-read" as PermissionName })).state,
  );
  expect(before).not.toBe("granted");

  const result = await extractCredentials("fixture-session");
  expect(result.credentials.api_key).toBe(key);
  expect(
    await page.evaluate(
      async () =>
        (await navigator.permissions.query({ name: "clipboard-read" as PermissionName })).state,
    ),
  ).toBe("granted");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key);
});

it("vaults a Vast-shaped hex key that only the Copy button puts on the clipboard", async () => {
  // Vast.ai's created-key dialog shows a truncated stub and writes the full
  // 64-char lowercase hex key to the clipboard; the key never enters the DOM.
  // An existing key's stub stays visible in the list behind the dialog.
  const key = "d7bd47d70c1e4f2a9b3c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80bd4a";
  await context.clearPermissions();
  await page.evaluate(() => navigator.clipboard.writeText("")).catch(() => undefined);
  const html = `<!doctype html>
  <table><tr><th>Key</th></tr><tr><td>0a1b2c3d...9f8e</td></tr></table>
  <div role="dialog" aria-label="API key created">
    <h2>API key created</h2>
    <label>API key <input readonly value="${key.slice(0, 8)}...${key.slice(-4)}"></label>
    <button type="button" aria-label="Copy API key">Copy</button>
  </div>
  <script>document.querySelector('[aria-label="Copy API key"]')
    .addEventListener('click', () => navigator.clipboard.writeText(atob('${Buffer.from(key).toString("base64")}')));</script>`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://127.0.0.1/");
  expect(await page.content()).not.toContain(key);

  const result = await extractCredentials("fixture-session");
  expect(result.credentials).toEqual({ api_key: key });
});

it("vaults a Kenari key shown inline after its dialog closes, via its Indonesian Salin button", async () => {
  // Kenari 23 Nov: after "Buat Key" the dialog closes and /keys shows the new
  // key once in an inline banner (no dialog role, nothing covering the page)
  // with "Salin" (Copy) → "Tersalin" (Copied) and "Tutup" (Close) beside it.
  // A quickstart sample embeds the same key next to its own Salin button.
  const key = "kn-Q7wE3rT9yU2iO5pA8sD1fG4hJ6kL0zX3cV7bN9mQ2wE5rT8y";
  await context.clearPermissions();
  await page.evaluate(() => navigator.clipboard.writeText("")).catch(() => undefined);
  const html = `<!doctype html>
  <header><button>M methoxine@example.test Keluar</button></header>
  <main>
    <h1>API Keys</h1>
    <button>Buat API Key</button>
    <section class="banner">
      <p>Simpan key ini sekarang. Key hanya ditampilkan sekali.</p>
      <div class="row"><code id="revealed">${key}</code>
        <button type="button" id="salin">Salin</button></div>
      <button type="button">Tutup</button>
      <a href="/docs/quickstart">Buka quickstart</a>
    </section>
    <div class="sample"><pre>curl https://kenari.id/v1/chat -H "Authorization: Bearer ${key}"</pre>
      <button type="button" id="sample">Salin</button></div>
    <table>
      <tr><td>kn-08d5677c grunt 23</td><td><button>Ubah pengaturan key</button>
        <button>Ganti key</button><button>Cabut key</button></td></tr>
      <tr><td>kn-15a068f0 22</td><td><button>Ubah pengaturan key</button>
        <button>Ganti key</button><button>Cabut key</button></td></tr>
    </table>
  </main>
  <script>
    document.getElementById('salin').addEventListener('click', async (event) => {
      await navigator.clipboard.writeText(document.getElementById('revealed').textContent);
      event.target.textContent = 'Tersalin';
    });
    document.getElementById('sample').addEventListener('click', () =>
      navigator.clipboard.writeText(document.querySelector('pre').textContent));
  </script>`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://127.0.0.1/keys");

  const result = await extractCredentials("fixture-session");
  expect(result.credentials).toEqual({ api_key: key });
  expect(await page.locator("#salin").textContent()).toBe("Tersalin");
});

it("does not copy from an inline Salin button outside a key context", async () => {
  await context.clearPermissions();
  await page.evaluate(() => navigator.clipboard.writeText("")).catch(() => undefined);
  const html = `<!doctype html>
  <h1>Sample identifier</h1>
  <div><code>kn-08d5677c</code><button type="button" id="salin">Salin</button></div>
  <script>document.getElementById('salin').addEventListener('click', () =>
    navigator.clipboard.writeText('kn-08d5677c'));</script>`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://127.0.0.1/keys");

  const result = await extractCredentials("fixture-session");
  expect(result.credentials).toEqual({});
});

it("copies a created key from a dialog whose Copy control is labelled in Spanish", async () => {
  const key = "fixture_Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe9Dc8Ba7";
  await context.clearPermissions();
  await page.evaluate(() => navigator.clipboard.writeText("")).catch(() => undefined);
  const html = `<!doctype html>
  <div role="dialog" aria-label="Clave API creada">
    <h2>API key creada</h2><div>Clave: ••••••••</div>
    <button type="button" id="copiar">Copiar</button>
  </div>
  <script>document.getElementById('copiar').addEventListener('click', () =>
    navigator.clipboard.writeText(atob('${Buffer.from(key).toString("base64")}')));</script>`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://127.0.0.1/");

  const result = await extractCredentials("fixture-session");
  expect(result.credentials).toEqual({ api_key: key });
});

it.each([false, true])(
  "refuses competing unmasked keys with unequal wrappers: %s",
  async (wrapped) => {
    const keys = [
      "kn-A1sD2fG3hJ4kL5zX6cV7bN8mQ9wE0rT1yU2iO3pA4sD5fG",
      "kn-Z9xC8vB7nM6aS5dF4gH3jK2lQ1wE0rT9yU8iO7pL6kJ5hG",
    ];
    await context.clearPermissions();
    await page.evaluate(() => navigator.clipboard.writeText("")).catch(() => undefined);
    const html = `<!doctype html><h1>API Keys</h1><ul>${keys
      .map(
        (key, index) =>
          `<li>${wrapped && index === 0 ? "<span>" : ""}<code>${key}</code>${wrapped && index === 0 ? "</span>" : ""}<button type="button" data-index="${index}">Copy</button></li>`,
      )
      .join("")}</ul>
  <script>document.querySelectorAll('[data-index]').forEach((button) =>
    button.addEventListener('click', () =>
      navigator.clipboard.writeText(button.previousElementSibling.textContent)));</script>`;
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto("http://127.0.0.1/keys");

    const result = await extractCredentials("fixture-session");
    expect(result.credentials).toEqual({});
  },
);

it.each(["plain", "wrapped", "icon", "replaced icon", "replaced source"])(
  "vaults a Zro key with control: %s",
  async (variant) => {
    const wrapped = variant !== "plain";
    // Zro 23 Nov (run after Grunt #182, trace rows 9-11): Create closed the form
    // dialog and /api-keys showed the key once in an inline, non-modal panel with
    // Dismiss / Copy key / Done, plus a setup snippet carrying its own
    // credential-shaped value beside Copy setup. Nothing on the page was covered.
    const key = "zro_Hk3Lm9Np2Qr8St4Uv7Wx1Yz5Ab6Cd0Ef";
    const setupToken = "zsetup_Gh2Jk4Lm6Np8Qr0St3Uv5Wx7Yz9Ab1";
    await context.clearPermissions();
    await page.evaluate(() => navigator.clipboard.writeText("")).catch(() => undefined);
    const html = `<!doctype html><main><h1>API keys</h1><button>Create key</button>
    <section class="panel"><h2>Your new key</h2>
      <div>${wrapped ? "<span>" : ""}<code id="key">${key}</code>${wrapped ? "</span>" : ""}<button type="button" id="new-key-control">${variant.includes("icon") ? "⧉" : "Copy key"}</button></div>
      <button type="button">Dismiss</button><button type="button">Done</button>
      <h3>Use Zro from npm</h3>
      <div><code id="setup">ZRO_SETUP=${setupToken}</code>
        <button type="button" id="copy-setup">Copy setup</button></div>
    </section>
    <h2>Active keys</h2><ul><li>grunt-20261123-1809 <button>Revoke grunt-20261123-1809</button></li></ul>
  </main>
  <script>
    document.getElementById('new-key-control').addEventListener('click', async (event) => {
      await navigator.clipboard.writeText(document.getElementById('key').textContent);
      event.target.textContent = 'Copied';
      if (${variant.startsWith("replaced")}) event.target.replaceWith(event.target.cloneNode(true));
    });
    document.getElementById('copy-setup').addEventListener('click', () =>
      navigator.clipboard.writeText(document.getElementById('setup').textContent));
  </script>`;
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto("http://127.0.0.1/api-keys");

    if (variant.includes("icon") || variant === "replaced source") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      if (variant.includes("icon"))
        expect((await extractCredentials("fixture-session")).credentials).toEqual({});
      await page.evaluate(() => {
        (
          window as Window & { __tsDriveRegistry?: { nodes: Map<string, Element | null> } }
        ).__tsDriveRegistry = {
          nodes: new Map([["key", document.getElementById("new-key-control")]]),
        };
      });
      expect(await copySourceClick(page, "key")).toBe(
        variant === "replaced source" ? "source" : "candidate",
      );
      await page.locator("#new-key-control").click();
    }
    const result = await extractCredentials("fixture-session");
    expect(result.credentials).toEqual({ api_key: key });
    expect(await page.locator("#new-key-control").textContent()).toBe("Copied");
    // A retry after a failed store finds the same control under its new label;
    // "Copied" beside "Copy setup" no longer names a key on its own.
    await page.evaluate(() => navigator.clipboard.writeText(""));
    const retried = await extractCredentials("fixture-session");
    expect(retried.credentials).toEqual(variant.startsWith("replaced") ? {} : { api_key: key });
  },
);

it("does not take a highlighted code sample's Copy for the revealed key", async () => {
  // A syntax highlighter puts the key in its own span inside the curl sample,
  // and that sample's Salin sits closer to the span than the banner's Salin
  // sits to the banner's key. Only the banner shows the key by itself.
  const key = "kn-Q7wE3rT9yU2iO5pA8sD1fG4hJ6kL0zX3cV7bN9mQ2wE5rT8y";
  await context.clearPermissions();
  await page.evaluate(() => navigator.clipboard.writeText("")).catch(() => undefined);
  const html = `<!doctype html><main><h1>API Keys</h1>
    <div style="display:flex;align-items:center"><pre style="margin:0"><code><span>curl</span> https://kenari.id/v1/chat -H <span>"Authorization: Bearer</span> <span>${key}</span>"</code></pre><button type="button" id="sample">Salin</button></div>
    <section style="margin-top:40px"><code id="revealed">${key}</code>
      <div style="margin:200px 0 0 700px"><button type="button" id="salin">Salin</button></div></section></main>
  <script>
    document.getElementById('salin').addEventListener('click', () =>
      navigator.clipboard.writeText(document.getElementById('revealed').textContent));
    document.getElementById('sample').addEventListener('click', () =>
      navigator.clipboard.writeText(document.querySelector('pre').textContent));
  </script>`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://127.0.0.1/keys");

  const result = await extractCredentials("fixture-session");
  expect(result.credentials).toEqual({ api_key: key });
});

it("does not promote an icon candidate from another holder's stale clipboard value", async () => {
  const key = "kn-Q7wE3rT9yU2iO5pA8sD1fG4hJ6kL0zX3cV7bN9mQ2wE5rT8y";
  const oldKey = "zro_Hk3Lm9Np2Qr8St4Uv7Wx1Yz5Ab6Cd0Ef";
  const html = `<!doctype html><h1>API keys</h1>
    <div><code>${key}</code><button id="new">⧉</button></div>
    <div><code>${oldKey}</code><button>⧉</button></div>`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://127.0.0.1/api-keys");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(async (value) => {
    await navigator.clipboard.writeText(value);
    (
      window as Window & { __tsDriveRegistry?: { nodes: Map<string, Element | null> } }
    ).__tsDriveRegistry = { nodes: new Map([["new", document.getElementById("new")]]) };
  }, oldKey);
  expect(await copySourceClick(page, "new")).toBe("candidate");
  await page.locator("#new").click();
  expect((await extractCredentials("fixture-session")).credentials).toEqual({});
});

it("prefers the named Copy key control over a generic Copy control", async () => {
  const key = "zro_Hk3Lm9Np2Qr8St4Uv7Wx1Yz5Ab6Cd0Ef";
  const html = `<!doctype html><h1>API keys</h1>
    <div><code>API_KEY=${key}</code><button id="setup">Copy</button></div>
    <section><code>${key}</code><div style="margin:200px 0 0 700px"><button id="key">Copy key</button></div></section>
    <script>
      document.getElementById('setup').onclick = () => navigator.clipboard.writeText('API_KEY=${key}');
      document.getElementById('key').onclick = () => navigator.clipboard.writeText('${key}');
    </script>`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://127.0.0.1/api-keys");
  expect((await extractCredentials("fixture-session")).credentials).toEqual({ api_key: key });
});

it("requires an inline source and its remembered retry to copy the associated bare token", async () => {
  const key = "zro_Hk3Lm9Np2Qr8St4Uv7Wx1Yz5Ab6Cd0Ef";
  const html = `<!doctype html><h1>API keys</h1>
    <div><code>${key}</code><button>Copy key</button></div>
    <script>
      window.copiedValue = 'API_KEY=${key}';
      document.querySelector('button').onclick = () => navigator.clipboard.writeText(window.copiedValue);
    </script>`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://127.0.0.1/api-keys");
  expect((await extractCredentials("fixture-session")).credentials).toEqual({});
  await page.evaluate((value) => {
    Reflect.set(window, "copiedValue", value);
  }, key);
  expect((await extractCredentials("fixture-session")).credentials).toEqual({ api_key: key });
  await page.evaluate((value) => {
    Reflect.set(window, "copiedValue", value);
  }, `API_KEY=${key}`);
  expect((await extractCredentials("fixture-session")).credentials).toEqual({});
});

it.each(["⧉", '<svg width="16" height="16"><rect width="12" height="12" /></svg>'])(
  "recognizes an icon dispatch beside a nested captioned key: %s",
  async (icon) => {
    const key = "zro_Hk3Lm9Np2Qr8St4Uv7Wx1Yz5Ab6Cd0Ef";
    const html = `<!doctype html><h1>API keys</h1>
      <div>API key: <span>${key}</span><button id="icon-control">${icon}</button></div>
      <script>document.getElementById('icon-control').onclick = () => navigator.clipboard.writeText('${key}');</script>`;
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto("http://127.0.0.1/api-keys");
    expect((await extractCredentials("fixture-session")).credentials).toEqual({});
    await page.evaluate(async () => {
      await navigator.clipboard.writeText("");
      (
        window as Window & { __tsDriveRegistry?: { nodes: Map<string, Element | null> } }
      ).__tsDriveRegistry = {
        nodes: new Map([["copy", document.getElementById("icon-control")]]),
      };
    });
    expect(await copySourceClick(page, "copy")).toBe("candidate");
    await page.locator("#icon-control").click();
    expect((await extractCredentials("fixture-session")).credentials).toEqual({ api_key: key });
  },
);

it("vaults a key written as plain text directly beside its Salin button", async () => {
  // The key is a bare text child of the same element as its Copy control, so
  // that element's whole text reads "<key>Salin".
  const key = "kn-Q7wE3rT9yU2iO5pA8sD1fG4hJ6kL0zX3cV7bN9mQ2wE5rT8y";
  await context.clearPermissions();
  await page.evaluate(() => navigator.clipboard.writeText("")).catch(() => undefined);
  const html = `<!doctype html><h1>API Keys</h1><div id="row">${key}<button type="button">Salin</button></div>
  <script>document.querySelector('button').addEventListener('click', () =>
    navigator.clipboard.writeText('${key}'));</script>`;
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://127.0.0.1/keys");

  const result = await extractCredentials("fixture-session");
  expect(result.credentials).toEqual({ api_key: key });
});
