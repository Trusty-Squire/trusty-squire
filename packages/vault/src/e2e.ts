const ITERATIONS = 600_000;

export interface E2EBlob {
  v: 1;
  kdf: "pbkdf2-sha256";
  iter: number;
  salt: string;
  iv: string;
  ct: string;
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
) {
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const keyBytes = await globalThis.crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations,
    },
    keyMaterial,
    256,
  );
  return globalThis.crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptCard(
  passphrase: string,
  card: Record<string, unknown>,
): Promise<E2EBlob> {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    new TextEncoder().encode(JSON.stringify(card)),
  );

  return {
    v: 1,
    kdf: "pbkdf2-sha256",
    iter: ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptCard(
  passphrase: string,
  blob: E2EBlob,
): Promise<Record<string, unknown>> {
  const salt = fromBase64(blob.salt);
  const iv = fromBase64(blob.iv);
  const ciphertext = fromBase64(blob.ct);
  if (
    blob.v !== 1
    || blob.kdf !== "pbkdf2-sha256"
    || salt.length !== 16
    || iv.length !== 12
    || ciphertext.length < 16
  ) {
    throw new Error("Invalid encrypted card");
  }
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
}
