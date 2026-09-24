import { randomBytes } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import { type Socket } from "node:net";
import { type AddressInfo } from "node:net";

export interface NoVncFinishProxy {
  token: string;
  port: number;
  close: () => Promise<void>;
}

/** Serve noVNC through the same tunnel as a nonce-scoped Finish callback. */
export async function startNoVncFinishProxy(
  port: number,
  backendPort: number,
  onFinish: () => Promise<void>,
): Promise<NoVncFinishProxy> {
  const token = randomBytes(24).toString("hex");
  const finishPath = `/finish/${token}`;
  const sockets = new Set<Socket>();
  const upstreamSockets = new Set<Socket>();
  const server: Server = createServer((incoming, outgoing) => {
    if (incoming.url?.startsWith("/finish/")) {
      if (incoming.method !== "POST" || incoming.url !== finishPath) {
        outgoing.writeHead(404).end();
        return;
      }
      void onFinish().then(
        () => outgoing.writeHead(204, { "Cache-Control": "no-store" }).end(),
        () => outgoing.writeHead(502, { "Cache-Control": "no-store" }).end(),
      );
      return;
    }
    const proxied = request(
      {
        hostname: "127.0.0.1",
        port: backendPort,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    proxied.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(proxied);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (incoming, socket, head) => {
    const proxied = request({
      hostname: "127.0.0.1",
      port: backendPort,
      method: incoming.method,
      path: incoming.url,
      headers: incoming.headers,
    });
    proxied.on("upgrade", (response, upstream, upstreamHead) => {
      upstreamSockets.add(upstream);
      upstream.on("close", () => upstreamSockets.delete(upstream));
      socket.write(`HTTP/1.1 ${response.statusCode ?? 101} Switching Protocols\r\n`);
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) socket.write(`${name}: ${value}\r\n`);
      }
      socket.write("\r\n");
      if (head.length) upstream.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      socket.pipe(upstream).pipe(socket);
    });
    proxied.on("response", (response) => {
      const status = response.statusCode ?? 502;
      socket.end(
        `HTTP/1.1 ${status} Upstream refused upgrade\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      response.destroy();
    });
    proxied.on("error", () => socket.destroy());
    proxied.end();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    token,
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        for (const socket of upstreamSockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
