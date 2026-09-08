import { BrokerClient } from "../../broker/transport.js";
const [path, token] = process.argv.slice(2);
if (path === undefined || token === undefined) throw new Error("Missing fixture arguments");
const client = await BrokerClient.connect(path, token);
try {
  const result = await client.call("overlap", { pid: process.pid });
  process.stdout.write(JSON.stringify(result) + "\n");
} finally {
  await client.close();
}
