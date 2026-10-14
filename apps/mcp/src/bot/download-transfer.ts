import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join, parse as parsePath } from "node:path";
import { pipeline } from "node:stream/promises";
import { redeemDownloadHandle } from "./downloads.js";

// Delivers a download handle over the shared MCP socket to a process on the
// agent's machine. The client sends this prefix plus the handle as its first
// line, instead of an agent identity. The broker replies with one JSON header
// line, then the raw file bytes.
export const DOWNLOAD_HANDLE_PREFIX = "trusty-squire-download ";

interface Header {
  ok: boolean;
  error?: string;
  filename?: string;
  size_bytes?: number;
  sha256?: string;
}

/** Broker side: stream one redeemed handle, then close the socket. */
export function serveDownloadHandle(socket: Socket, handle: string): void {
  const redeemed = redeemDownloadHandle(handle);
  if (redeemed === null) {
    socket.end(`${JSON.stringify({ ok: false, error: "unknown_or_expired_handle" })}\n`);
    return;
  }
  const header: Header = {
    ok: true,
    filename: redeemed.filename,
    size_bytes: redeemed.size_bytes,
    sha256: redeemed.sha256,
  };
  socket.write(`${JSON.stringify(header)}\n`);
  void pipeline(createReadStream(redeemed.path), socket).catch(() => socket.destroy());
}

export interface FetchedDownload {
  path: string;
  size_bytes: number;
  sha256: string;
}

/** Agent side: redeem a handle and write the file into destDir. */
export async function fetchDownloadHandle(
  socketPath: string,
  handle: string,
  destDir: string,
): Promise<FetchedDownload> {
  const socket = createConnection(socketPath);
  socket.write(`${DOWNLOAD_HANDLE_PREFIX}${handle}\n`);
  const header = await new Promise<{ header: Header; rest: Buffer }>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(10);
      if (end < 0) {
        if (buffered.length > 4096) reject(new Error("download handle reply has no header"));
        return;
      }
      socket.off("data", onData);
      socket.off("error", reject);
      socket.pause();
      try {
        resolve({
          header: JSON.parse(buffered.subarray(0, end).toString("utf8")) as Header,
          rest: buffered.subarray(end + 1),
        });
      } catch (error) {
        reject(error);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("end", () => reject(new Error("broker closed the connection before replying")));
  });
  if (!header.header.ok || !header.header.filename || !header.header.sha256) {
    socket.destroy();
    throw new Error(`download handle refused: ${header.header.error ?? "invalid reply"}`);
  }
  const { filename, sha256: expected } = header.header;
  const partial = join(destDir, `.${parsePath(filename).base}.${process.pid}.partial`);
  const hash = createHash("sha256");
  let size = 0;
  const out = createWriteStream(partial, { flags: "wx", mode: 0o600 });
  try {
    socket.unshift(header.rest);
    socket.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      size += chunk.length;
    });
    await pipeline(socket, out);
    const sha256 = hash.digest("hex");
    if (sha256 !== expected) throw new Error("received file does not match the download sha256");
    const path = await claimName(partial, destDir, filename);
    return { path, size_bytes: size, sha256 };
  } finally {
    await rm(partial, { force: true });
  }
}

// Hard-link the finished file under the first free name, so an existing file
// is never overwritten.
async function claimName(partial: string, destDir: string, filename: string): Promise<string> {
  const { name, ext } = parsePath(filename);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const path = join(destDir, attempt === 0 ? filename : `${name} (${attempt})${ext}`);
    try {
      await link(partial, path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("dest_dir already holds 100 files with this name");
}
