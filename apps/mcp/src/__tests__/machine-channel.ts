// The `connect --json` machine channel is stdout's DESCRIPTOR: `emitConnectReport`
// writes it synchronously so an immediate `process.exit` cannot drop the line.
// Capturing it therefore means redirecting that descriptor, not spying on the
// stream — which is also what makes the capture read back exactly the bytes a
// caller piping stdout would receive.
//
// One copy, imported by every suite that reads the channel: two hand-copied
// redirects can drift, and one that forgets to restore leaks a redirected
// stdout into every test after it.

import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MachineChannelCapture {
  /** Everything written to the channel. Valid before and after `restore`. */
  read: () => string;
  /** Puts the real descriptor back. Always call this in a `finally`. */
  restore: () => void;
}

export function captureMachineChannel(): MachineChannelCapture {
  const dir = mkdtempSync(join(tmpdir(), "ts-machine-channel-"));
  const file = join(dir, "machine.json");
  const fd = openSync(file, "w+");
  const original = process.stdout.fd;
  Object.defineProperty(process.stdout, "fd", { value: fd, configurable: true, writable: true });
  let written: string | null = null;
  return {
    read: () => written ?? readFileSync(file, "utf8"),
    restore: () => {
      if (written !== null) return;
      written = readFileSync(file, "utf8");
      Object.defineProperty(process.stdout, "fd", {
        value: original,
        configurable: true,
        writable: true,
      });
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
