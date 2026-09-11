import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { ApiClient } from "../api-client.js";
import { buildServer } from "../server.js";

it("discovers Exa, Groq and Cartesia through MCP without returning the 68-record inventory", async () => {
  const credentials = Array.from({ length: 68 }, (_, i) => ({
    id: `c${i}`,
    reference: `vault://synthetic/c${i}`,
    service: ["Exa", "Groq", "Cartesia", "Exa Cloud", null][i] ?? (i === 4 ? null : `Other-${i}`),
    label: "default",
    field_names: ["api_key"],
    allowed_hosts: [`api.service-${i}.example`],
    created_at: "2026-09-11T00:00:00.000Z",
    stale: i === 1,
    key_name: "API_KEY",
    type: "api_key",
    auth_strategy: "api_key",
    signin_url: null,
    login_hosts: [],
    last_retrieved_at: null,
    retrieval_count: 0,
  }));
  const requests: string[] = [];
  const fixture = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    expect(req.headers.authorization).toBe("Bearer synthetic-session");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ credentials }));
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address() as { port: number };
  const api = new ApiClient({
    apiBaseUrl: `http://127.0.0.1:${address.port}`,
    registryBaseUrl: `http://127.0.0.1:${address.port}`,
    agentSessionToken: "synthetic-session",
  });
  const server = await buildServer(api);
  const client = new Client({ name: "credential-discovery-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const transcript: unknown[] = [];
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const advertised = (await client.listTools()).tools.find(
      (tool) => tool.name === "list_credentials",
    )!;
    expect(Object.keys(advertised.inputSchema.properties ?? {}).sort()).toEqual([
      "fields",
      "service",
    ]);
    transcript.push({ method: "tools/list", tool: advertised });
    const call = async (args: Record<string, unknown>) => {
      const response = await client.callTool({ name: "list_credentials", arguments: args });
      transcript.push({ method: "tools/call", arguments: args, response });
      return response;
    };
    const parse = (response: Awaited<ReturnType<typeof call>>) => {
      expect(response.isError).not.toBe(true);
      return JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
    };
    const full = parse(await call({}));
    expect(full.credentials).toEqual(credentials);
    const compact = parse(await call({ service: ["EXA", "groq", "Cartesia"], fields: "summary" }));
    expect(compact.credentials).toEqual(
      credentials.slice(0, 3).map((row) => ({
        reference: row.reference,
        service: row.service,
        label: row.label,
        field_names: row.field_names,
        allowed_hosts: row.allowed_hosts,
        created_at: row.created_at,
        stale: row.stale,
      })),
    );
    expect(parse(await call({ service: "exa" })).credentials).toEqual([credentials[0]]);
    expect(parse(await call({ service: "missing", fields: "summary" }))).toEqual({
      credentials: [],
    });
    expect((await call({ service: [] })).isError).toBe(true);
    expect((await call({ fields: "full" })).isError).toBe(true);
    expect(requests).toEqual(Array(4).fill("GET /v1/vault/credentials"));
    const fullBytes = Buffer.byteLength(JSON.stringify(full));
    const compactBytes = Buffer.byteLength(JSON.stringify(compact));
    expect(compactBytes).toBeLessThan(fullBytes / 10);
    if (process.env.LIST_CREDENTIALS_EVIDENCE) {
      await writeFile(
        process.env.LIST_CREDENTIALS_EVIDENCE,
        JSON.stringify(
          {
            environment:
              "Real MCP server, SDK client and ApiClient; local HTTP fixture with 68 synthetic metadata records. No production vault access.",
            fullBytes,
            compactBytes,
            httpRequests: requests,
            transcript,
          },
          null,
          2,
        ) + "\n",
      );
    }
  } finally {
    await client.close();
    await server.close();
    await new Promise<void>((resolve, reject) =>
      fixture.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
