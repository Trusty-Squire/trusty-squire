// Shared fixture for tests that inject a `dispatch` into HttpProxyExecutor.
// A dispatcher resolves on upstream headers and hands back the live body
// stream, so a fake must do the same — there is no string-body shape.

import { Readable } from "node:stream";

export function streamOf(text: string): Readable {
  return Readable.from([Buffer.from(text, "utf8")]);
}
