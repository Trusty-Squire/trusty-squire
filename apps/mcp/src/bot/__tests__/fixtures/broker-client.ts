import { BrokerClient } from "../../broker/transport.js";
const [path] = process.argv.slice(2);
if (path === undefined) throw new Error("Missing fixture arguments");
// Connecting takes nothing: the socket path is the whole credential.
const client = await BrokerClient.connect(path);
try {
  const result = await client.call("overlap", { pid: process.pid });
  process.stdout.write(JSON.stringify(result) + "\n");
} finally {
  await client.close();
}
