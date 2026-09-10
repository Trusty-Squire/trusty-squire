import readline from "node:readline";

const mode = process.argv[2];
if (mode === "dependency-error") {
  process.stderr.write(
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'signal-exit' imported from /tmp/npm-cache/pkg.js\n",
  );
  process.exit(1);
}
if (mode === "transport-close") process.exit(0);
if (mode === "protocol-error") {
  process.stdout.write("native host returned non-json content\n");
  process.exit(0);
}
if (mode === "timeout") {
  setInterval(() => {}, 1_000);
} else {
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method !== "initialize") return;
    process.stderr.write(
      "launch https://example.test/path?token=re_secret_token Bearer ts_agent_secretvalue\n",
    );
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: {
            name: "fixture-mcp",
            version: mode === "version-mismatch" ? "0.0.1" : "1.2.3",
          },
        },
      })}\n`,
    );
  });
}
