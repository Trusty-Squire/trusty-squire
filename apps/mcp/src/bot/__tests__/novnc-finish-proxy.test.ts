import { createServer, request } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startNoVncFinishProxy, type NoVncFinishProxy } from "../novnc-finish-proxy.js";

describe("noVNC Finish bridge", () => {
  let proxy: NoVncFinishProxy | undefined;
  const backend = createServer((_request, response) => response.end("noVNC page"));

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
    if (backend.listening) await new Promise<void>((resolve) => backend.close(() => resolve()));
  });

  it("routes Finish to the ceremony callback on the same tunnel, without exposing it to another token", async () => {
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
    const backendPort = (backend.address() as { port: number }).port;
    let finished = 0;
    proxy = await startNoVncFinishProxy(0, backendPort, async () => {
      finished += 1;
    });
    const port = proxy.port;
    const page = await fetch(`http://127.0.0.1:${port}/vnc.html`);
    expect(await page.text()).toBe("noVNC page");
    const wrong = await fetch(`http://127.0.0.1:${port}/finish/wrong`, { method: "POST" });
    expect(wrong.status).toBe(404);
    expect(finished).toBe(0);
    const result = await fetch(`http://127.0.0.1:${port}/finish/${proxy.token}`, {
      method: "POST",
    });
    expect(result.status).toBe(204);
    expect(finished).toBe(1);
  });

  it("keeps the noVNC WebSocket connected through the Finish bridge", async () => {
    let backendSocket: import("node:stream").Duplex | undefined;
    backend.on("upgrade", (incoming, socket) => {
      backendSocket = socket;
      const accept = createHash("sha1")
        .update(`${incoming.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.write(Buffer.from([0x81, 0x02, 0x6f, 0x6b]));
    });
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
    proxy = await startNoVncFinishProxy(
      0,
      (backend.address() as { port: number }).port,
      async () => {},
    );
    const key = randomBytes(16).toString("base64");
    try {
      const message = await new Promise<Buffer>((resolve, reject) => {
        const client = request({
          hostname: "127.0.0.1",
          port: proxy!.port,
          path: "/websockify",
          headers: {
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Key": key,
            "Sec-WebSocket-Version": "13",
          },
        });
        client.on("upgrade", (response, socket, head) => {
          if (response.statusCode !== 101) {
            reject(new Error(`WebSocket upgrade returned ${response.statusCode}`));
            socket.destroy();
            return;
          }
          const expectedAccept = createHash("sha1")
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest("base64");
          if (response.headers["sec-websocket-accept"] !== expectedAccept) {
            reject(new Error("WebSocket accept key did not survive the proxy"));
            socket.destroy();
            return;
          }
          if (head.length) {
            resolve(head);
            socket.destroy();
          } else {
            socket.once("data", (data: Buffer) => {
              resolve(data);
              socket.destroy();
            });
          }
        });
        client.on("error", reject);
        client.end();
      });
      expect(message).toEqual(Buffer.from([0x81, 0x02, 0x6f, 0x6b]));
    } finally {
      backendSocket?.destroy();
    }
  });
});
