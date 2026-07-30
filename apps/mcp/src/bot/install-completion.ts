import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const INSTALL_COMPLETION_FRAGMENT_KEY = "ts_install_complete";

const COMPLETION_PATH_PREFIX = "/.well-known/trusty-squire/install-complete/";

export interface InstallCompletionListener {
  callbackUrl: string;
  isCompleted: () => boolean;
  close: () => Promise<void>;
}

/**
 * Add the per-run loopback completion URL to the install page fragment.
 *
 * A fragment is deliberate: it is available to the browser app but is never
 * sent to Trusty Squire, an OAuth provider, or an intermediary's request logs.
 */
export function withInstallCompletionCallback(confirmUrl: string, callbackUrl: string): string {
  const url = new URL(confirmUrl);
  const fragment = new URLSearchParams(url.hash.slice(1));
  fragment.set(INSTALL_COMPLETION_FRAGMENT_KEY, callbackUrl);
  url.hash = fragment.toString();
  return url.toString();
}

/**
 * Listen for the install wizard's explicit Finish action without attaching
 * CDP to Chrome. The browser runs on this same host, so its top-level
 * navigation to 127.0.0.1 reaches this process even when the user is driving
 * it remotely through noVNC.
 */
export async function startInstallCompletionListener(
  doneUrl: string,
  confirmUrl = doneUrl,
): Promise<InstallCompletionListener> {
  const nonce = randomBytes(24).toString("hex");
  const completionPath = `${COMPLETION_PATH_PREFIX}${nonce}`;
  const acknowledgementPath = `${completionPath}/ack`;
  let completed = false;

  const server = createServer((req, res) => {
    const path = req.url === undefined ? "" : new URL(req.url, "http://127.0.0.1").pathname;
    if (req.method === "GET" && path === acknowledgementPath) {
      const redirect = new URL(confirmUrl);
      const fragment = new URLSearchParams(redirect.hash.slice(1));
      const address = server.address() as AddressInfo;
      fragment.set(
        INSTALL_COMPLETION_FRAGMENT_KEY,
        `http://127.0.0.1:${address.port}${completionPath}`,
      );
      fragment.set("ts_install_complete_ack", "1");
      redirect.hash = fragment.toString();
      res.writeHead(302, {
        "Cache-Control": "no-store",
        Connection: "close",
        Location: redirect.toString(),
      });
      res.end();
      return;
    }
    if (req.method !== "GET" || path !== completionPath) {
      res.writeHead(404, {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("Not found");
      return;
    }

    completed = true;
    res.writeHead(302, {
      "Cache-Control": "no-store",
      Connection: "close",
      Location: doneUrl,
    });
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address() as AddressInfo;
  const callbackUrl = `http://127.0.0.1:${address.port}${completionPath}`;
  let closed = false;

  return {
    callbackUrl,
    isCompleted: () => completed,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      });
    },
  };
}
