import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { constants, publicEncrypt } from "node:crypto";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import type { ApiClient } from "../../api-client.js";
import { BrowserController } from "../browser.js";
import { finishProvisionSession, startHarnessProvisionSession } from "../provision-session.js";
import {
  provisionObserveTool,
  operateFillCredentialTool,
  operateTypeTool,
  operateClickTool,
} from "../../tools/provision-drive.js";

it("reads current login controls repeatedly and fills the matching saved fields in Chromium", async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const evidence = process.env.OPERATOR_LOGIN_EVIDENCE_DIR;
  const transcript: unknown[] = [];
  let sessionId: string | undefined;
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
    // Synthetic JAF-shaped native names, deliberately conflicting accessible labels.
    await page.route("https://fixture.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: route.request().url().endsWith("/dashboard")
          ? "<h1>Signed in</h1><p>Welcome, synthetic test account</p><button>Account settings</button>"
          : `<!doctype html><title>Synthetic login regression fixture</title>
          <h1>Login — synthetic test account</h1>
          <p>Native field names model JAF; accessible labels deliberately conflict.</p>
          <form onsubmit="event.preventDefault(); if(this.login_mail_address.value==='ada@example.test' && this.login_password.value==='synthetic-password') location.href='/dashboard'; else document.querySelector('#status').textContent='ID or password is incorrect'">
          <p>EMAIL <input id="email" name="login_mail_address" type="text" aria-label="Password"></p>
          <p>PASSWORD <input id="password" name="login_password" type="password" aria-label="Email address"></p>
          <button>Sign in</button></form><p id="status"></p>`,
      }),
    );
    const start = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: "https://fixture.test/login",
      observationFormat: "browser-use-dom",
      format: "compact",
    });
    sessionId = start.session_id;
    transcript.push({ tool: "operate_start (harness-owned Chromium)", response: start });
    const read = async (options: { role?: string; format?: "full" } = {}) => {
      const args = { session_id: sessionId!, ...options };
      const response = await provisionObserveTool.handler(args, null);
      transcript.push({ tool: "operate_observe", arguments: args, response });
      return response as { dom?: string; safe_table?: string[][]; delta?: boolean };
    };
    for (let i = 0; i < 2; i++) expect((await read({ format: "full" })).dom).toContain("Login");
    const controls = (await read({ role: "textbox" })).safe_table!;
    const email = controls.find((row) => row[2]?.includes("f=email"))!;
    const password = controls.find((row) => row[2]?.includes("f=password"))!;
    expect(email).toBeDefined();
    expect(password).toBeDefined();
    expect(email[0]).not.toBe(password[0]);
    const args = { session_id: sessionId, ref: password[0]!, slot: "not_loaded" };
    let guidance = "";
    try {
      await operateTypeTool.handler(args, null);
    } catch (error) {
      guidance = String(error);
    }
    transcript.push({ tool: "operate_type", arguments: args, error: guidance });
    expect(guidance).toMatch(
      /operate_fill_credential.*list_credentials.*field_names.*operate_type/,
    );
    expect(await page.locator("#password").inputValue()).toBe("");
    const api = {
      browserFillCredential: async (input: {
        fields: string[];
        current_host: string;
        encrypted_response_public_key: string;
      }) => {
        expect(input.current_host).toBe("https://fixture.test/login");
        expect(input.fields).toEqual(["username", "password"]);
        const encrypt = (value: string) =>
          publicEncrypt(
            {
              key: input.encrypted_response_public_key,
              padding: constants.RSA_PKCS1_OAEP_PADDING,
              oaepHash: "sha256",
            },
            Buffer.from(value),
          ).toString("base64");
        return {
          reference: "vault://synthetic/login",
          encrypted_fields: {
            username: encrypt("ada@example.test"),
            password: encrypt("synthetic-password"),
          },
        };
      },
    } as unknown as ApiClient;
    const loadArgs = operateFillCredentialTool.inputSchema.parse({
      session_id: sessionId,
      reference: "vault://synthetic/login",
      fields: ["username", "password"],
    });
    const loaded = (await operateFillCredentialTool.handler(loadArgs, api)) as {
      slots: Record<string, { slot: string }>;
    };
    transcript.push({
      tool: "operate_fill_credential (synthetic encrypted vault response)",
      arguments: loadArgs,
      response: loaded,
    });
    expect(JSON.stringify(loaded)).not.toContain("synthetic-password");
    for (const [row, field] of [
      [email, "username"],
      [password, "password"],
    ] as const) {
      const input = { session_id: sessionId, ref: row[0]!, slot: loaded.slots[field]!.slot };
      transcript.push({
        tool: "operate_type",
        arguments: input,
        response: await operateTypeTool.handler(input, null),
      });
      for (const options of [{}, { role: "textbox" }]) {
        const current = await read(options);
        expect(current.safe_table!.length).toBeGreaterThanOrEqual(2);
        expect(current.delta).toBeUndefined();
      }
    }
    expect(await page.locator("#email").inputValue()).toBe("ada@example.test");
    expect(await page.locator("#password").inputValue()).toBe("synthetic-password");
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, "login-filled.png") });
    }
    const button = (await read()).safe_table!.find((row) => row[2]?.split("|")[0] === "@sign-in")!;
    expect(button).toBeDefined();
    await operateClickTool.handler({ session_id: sessionId, ref: button[0]! }, null);
    await page.waitForURL("https://fixture.test/dashboard");
    for (let i = 0; i < 2; i++) expect((await read({ format: "full" })).dom).toContain("Signed in");
    expect((await read()).safe_table!.length).toBeGreaterThan(0);
    if (evidence) {
      await page.screenshot({ path: join(evidence, "login-complete.png") });
      await writeFile(
        join(evidence, "operator-login-responses.json"),
        JSON.stringify(transcript, null, 2),
      );
    }
  } finally {
    if (sessionId) await finishProvisionSession(sessionId);
    await browser.close();
  }
}, 60_000);
