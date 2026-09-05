// Egress failures through the REAL MCP tool-call path.
//
// The unit tests in tools/__tests__/egress-targets.test.ts inspect handler
// rejections and outcome payloads. This one asserts the thing the model
// actually receives: `server.ts` serializes a thrown `Error.message` into the
// tool result, so every egress failure family has to be checked at that
// boundary, not one layer earlier. If any of these ever carried the credential
// value, the vault's whole write-only property would be gone.

import { describe, expect, it, vi } from "vitest";
import { constants, publicEncrypt } from "node:crypto";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildServer } from "../server.js";
import type { ApiClient } from "../api-client.js";

const SECRET = "sk-live-must-never-reach-the-model-boundary";
const REFERENCE = "vault://acct/cred-1";

interface Scenario {
  fieldNames?: string[];
  fetchError?: Error;
  fetchFields?: Record<string, string>;
  githubStatus?: number;
}

function apiFor(scenario: Scenario): ApiClient {
  const fields = scenario.fetchFields ?? { api_key: SECRET };
  return {
    setRequestingAgent: vi.fn(),
    async listCredentials() {
      return {
        credentials: [
          {
            reference: REFERENCE,
            service: "browserstack",
            label: "default",
            field_names: scenario.fieldNames ?? Object.keys(fields),
            allowed_hosts: ["api.github.com", "local-file"],
          },
        ],
      };
    },
    async egressFetchCredential(input: {
      fields: string[];
      encrypted_response_public_key: string;
    }) {
      if (scenario.fetchError !== undefined) throw scenario.fetchError;
      const encrypted_fields: Record<string, string> = {};
      for (const name of input.fields) {
        encrypted_fields[name] = publicEncrypt(
          {
            key: input.encrypted_response_public_key,
            padding: constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256",
          },
          Buffer.from(fields[name] ?? "", "utf8"),
        ).toString("base64");
      }
      return { reference: REFERENCE, encrypted_fields };
    },
    async reportEgressOutcome() {
      return { recorded: true };
    },
  } as unknown as ApiClient;
}

async function callUseCredential(
  api: ApiClient,
  args: Record<string, unknown>,
): Promise<{ text: string; payload: string; isError: boolean }> {
  const server = await buildServer(api);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "egress-boundary-test", version: "1.0.0" });
  await client.connect(clientTransport);
  try {
    const result = (await client.callTool({ name: "use_credential", arguments: args })) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    return {
      // The whole wire response — what the model literally receives.
      text: JSON.stringify(result),
      // The unescaped payload, for asserting on its shape.
      payload: result.content.map((part) => part.text ?? "").join(""),
      isError: result.isError === true,
    };
  } finally {
    await client.close();
  }
}

const GITHUB_ARGS = {
  reference: REFERENCE,
  target: { kind: "github_repo_secret", owner: "octo", repo: "demo", name: "KEY" },
};

describe("egress failures at the MCP boundary never carry the field value", () => {
  it("surfaces a vault refusal without the secret", async () => {
    const api = apiFor({
      fetchError: new Error("POST /v1/vault/egress-fetch → 403 host_not_allowed"),
    });
    const { text, isError } = await callUseCredential(api, GITHUB_ARGS);
    expect(isError).toBe(true);
    expect(text).toContain("host_not_allowed");
    expect(text).not.toContain(SECRET);
  });

  it("surfaces an ambiguous-field refusal with the NAMES only", async () => {
    const api = apiFor({ fetchFields: { api_key: SECRET, client_secret: "also-secret" } });
    const { text, isError } = await callUseCredential(api, GITHUB_ARGS);
    expect(isError).toBe(true);
    expect(text).toContain("api_key");
    expect(text).toContain("client_secret");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("also-secret");
  });

  it("surfaces a missing GitHub token without the secret", async () => {
    // `gh` is not on PATH in the test process and GITHUB_TOKEN is unset here,
    // so this exercises the real token-resolution failure.
    const originalPath = process.env.PATH;
    const originalToken = process.env.GITHUB_TOKEN;
    const emptyBin = mkdtempSync(path.join(tmpdir(), "ts-egress-nogh-"));
    process.env.PATH = emptyBin;
    delete process.env.GITHUB_TOKEN;
    try {
      const api = apiFor({});
      const { text, isError } = await callUseCredential(api, GITHUB_ARGS);
      expect(isError).toBe(true);
      expect(text).toContain("gh auth login");
      expect(text).not.toContain(SECRET);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalToken !== undefined) process.env.GITHUB_TOKEN = originalToken;
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  it("surfaces a .env path refusal without the secret", async () => {
    const cwd = process.cwd();
    const root = await fs.realpath(mkdtempSync(path.join(tmpdir(), "ts-egress-boundary-")));
    process.chdir(root);
    try {
      const api = apiFor({});
      const { text, isError } = await callUseCredential(api, {
        reference: REFERENCE,
        target: { kind: "dotenv_write", path: "../escaped.env", name: "KEY" },
      });
      expect(isError).toBe(true);
      expect(text).toContain("path_outside_project");
      expect(text).not.toContain(SECRET);
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces a .env grammar refusal without the secret", async () => {
    const cwd = process.cwd();
    const root = await fs.realpath(mkdtempSync(path.join(tmpdir(), "ts-egress-boundary2-")));
    process.chdir(root);
    try {
      await fs.writeFile(path.join(root, ".env"), "KEY=a\nKEY=b\n");
      const api = apiFor({});
      const { text, isError } = await callUseCredential(api, {
        reference: REFERENCE,
        target: { kind: "dotenv_write", path: ".env", name: "KEY" },
      });
      expect(isError).toBe(true);
      expect(text).toContain("more than once");
      expect(text).not.toContain(SECRET);
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces an unknown credential without reaching the vault", async () => {
    const api = apiFor({});
    const { text, isError } = await callUseCredential(api, {
      reference: "vault://acct/does-not-exist",
      target: GITHUB_ARGS.target,
    });
    expect(isError).toBe(true);
    expect(text).toContain("credential_not_found");
    expect(text).not.toContain(SECRET);
  });

  it("returns a SUCCESS result that carries no value either", async () => {
    const cwd = process.cwd();
    const root = await fs.realpath(mkdtempSync(path.join(tmpdir(), "ts-egress-boundary3-")));
    process.chdir(root);
    try {
      const api = apiFor({});
      const { text, payload, isError } = await callUseCredential(api, {
        reference: REFERENCE,
        target: { kind: "dotenv_write", path: ".env", name: "KEY" },
      });
      expect(isError).toBe(false);
      expect(JSON.parse(payload)).toMatchObject({ written: true, name: "KEY" });
      expect(text).not.toContain(SECRET);
      // …and the value really did land in the file.
      expect(await fs.readFile(path.join(root, ".env"), "utf8")).toBe(`KEY="${SECRET}"\n`);
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
