import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";

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
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_base64url");
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export async function generateOperatorKeypair(): Promise<OperatorKeypair> {
  const keypair = await suite.kem.generateKeyPair();
  const [publicKey, serializedPrivateKey] = await Promise.all([
    suite.kem.serializePublicKey(keypair.publicKey),
    suite.kem.serializePrivateKey(keypair.privateKey),
  ]);
  const privateKeyBytes = new Uint8Array(serializedPrivateKey);
  try {
    return {
      publicKey: toBase64Url(new Uint8Array(publicKey)),
      privateKey: toBase64Url(privateKeyBytes),
    };
  } finally {
    privateKeyBytes.fill(0);
  }
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
  const privateKeyBytes = fromBase64Url(privateKey);
  const bytes = fromBase64Url(bundle);
  try {
    const recipientKey = await suite.kem.deserializePrivateKey(privateKeyBytes);
    const plaintext = await suite.open(
      { recipientKey, enc: bytes.slice(0, 32) },
      bytes.slice(32),
      aad,
    );
    return new Uint8Array(plaintext);
  } finally {
    privateKeyBytes.fill(0);
    bytes.fill(0);
  }
}
