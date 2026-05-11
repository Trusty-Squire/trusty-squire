// HKDF (RFC 5869) for deriving a session-bound KEK from the per-account
// KEK + a device-signed nonce.
//
// In chunk 6 the function is built and tested but NOT yet wired into
// the encryption flow — chunk 5's vault.store() doesn't pass a device
// assertion, so we can't bind a session to store-time + retrieve-time
// the way the long-form spec describes. Decryption uses the per-account
// KEK directly today; this primitive will be wired into a later chunk
// that introduces a per-access store flow.

import { Buffer } from "node:buffer";
import { hkdf } from "node:crypto";

const SESSION_INFO = "trusty-squire-vault-v1";
const SESSION_KEY_LEN = 32;

export class KekDerivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KekDerivationError";
  }
}

export async function deriveSessionKEK(
  accountKEK: Buffer,
  deviceSignedNonce: Buffer,
): Promise<Buffer> {
  if (accountKEK.length === 0) {
    throw new KekDerivationError("accountKEK must not be empty");
  }
  if (deviceSignedNonce.length === 0) {
    throw new KekDerivationError("deviceSignedNonce must not be empty");
  }

  return new Promise((resolve, reject) => {
    hkdf(
      "sha256",
      accountKEK,
      deviceSignedNonce,
      Buffer.from(SESSION_INFO, "utf8"),
      SESSION_KEY_LEN,
      (err, key) => {
        if (err) reject(err);
        else resolve(Buffer.from(key));
      },
    );
  });
}
