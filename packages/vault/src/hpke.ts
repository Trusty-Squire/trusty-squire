import {
  Aes256Gcm,
  CipherSuite,
  DhkemX25519HkdfSha256,
  HkdfSha256,
} from "@hpke/core";

export interface OperatorKeypair {
  publicKey: string;
  privateKey: string;
}

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (char) =>
    char.charCodeAt(0),
  );
}

export async function generateOperatorKeypair(): Promise<OperatorKeypair> {
  const keypair = await suite.kem.generateKeyPair();
  const [publicKey, privateKey] = await Promise.all([
    suite.kem.serializePublicKey(keypair.publicKey),
    suite.kem.serializePrivateKey(keypair.privateKey),
  ]);
  return {
    publicKey: toBase64Url(new Uint8Array(publicKey)),
    privateKey: toBase64Url(new Uint8Array(privateKey)),
  };
}

export async function sealToRecipient(
  recipientPublicKey: string,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<string> {
  const publicKey = await suite.kem.deserializePublicKey(fromBase64Url(recipientPublicKey));
  const { enc, ct } = await suite.seal({ recipientPublicKey: publicKey }, plaintext, aad);
  const bundle = new Uint8Array(enc.byteLength + ct.byteLength);
  bundle.set(new Uint8Array(enc));
  bundle.set(new Uint8Array(ct), enc.byteLength);
  return toBase64Url(bundle);
}

export async function openSealed(
  privateKey: string,
  bundle: string,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const recipientKey = await suite.kem.deserializePrivateKey(fromBase64Url(privateKey));
  const bytes = fromBase64Url(bundle);
  const plaintext = await suite.open(
    { recipientKey, enc: bytes.slice(0, 32) },
    bytes.slice(32),
    aad,
  );
  return new Uint8Array(plaintext);
}
