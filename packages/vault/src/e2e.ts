export interface E2EBlob {
  v: 1;
  cipher: "aes-256-gcm";
  iv: string;
  ct: string;
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function importKey(key: Uint8Array) {
  return globalThis.crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * Encrypts card fields entirely on the trusted client.
 *
 * The caller must keep the key out of server requests, agent context, logs,
 * and persistent storage. Only the returned opaque blob is safe to send to the
 * E2E vault API.
 */
export async function encryptCard(
  key: Uint8Array,
  card: Record<string, unknown>,
): Promise<E2EBlob> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await importKey(key);
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    cryptoKey,
    new TextEncoder().encode(JSON.stringify(card)),
  );

  return {
    v: 1,
    cipher: "aes-256-gcm",
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Decrypts an E2E card blob on the trusted client.
 *
 * The AES-GCM authentication tag rejects tampered ciphertext or the wrong key.
 */
export async function decryptCard(
  key: Uint8Array,
  blob: E2EBlob,
): Promise<Record<string, unknown>> {
  const iv = fromBase64(blob.iv);
  const ciphertext = fromBase64(blob.ct);
  if (blob.v !== 1 || blob.cipher !== "aes-256-gcm" || iv.length !== 12 || ciphertext.length < 16) {
    throw new Error("Invalid encrypted card");
  }
  const cryptoKey = await importKey(key);
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    cryptoKey,
    ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
}
