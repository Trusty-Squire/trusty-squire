import { describe, expect, it } from "vitest";
import { generateOperatorKeypair, openSealed, sealToRecipient } from "../hpke.js";

const message = new TextEncoder().encode("synthetic card payload");
const aad = new TextEncoder().encode("synthetic mandate");

describe("HPKE seal / open", () => {
  it("round-trips plaintext", async () => {
    const keypair = await generateOperatorKeypair();
    const bundle = await sealToRecipient(keypair.publicKey, message, aad);
    await expect(openSealed(keypair.privateKey, bundle, aad)).resolves.toEqual(message);
  });

  it("throws for the wrong private key", async () => {
    const recipient = await generateOperatorKeypair();
    const wrongRecipient = await generateOperatorKeypair();
    const bundle = await sealToRecipient(recipient.publicKey, message, aad);
    await expect(openSealed(wrongRecipient.privateKey, bundle, aad)).rejects.toThrow();
  });

  it("throws for a tampered bundle", async () => {
    const keypair = await generateOperatorKeypair();
    const bundle = await sealToRecipient(keypair.publicKey, message, aad);
    const index = Math.floor(bundle.length / 2);
    const tampered =
      `${bundle.slice(0, index)}${bundle[index] === "A" ? "B" : "A"}` + bundle.slice(index + 1);
    await expect(openSealed(keypair.privateKey, tampered, aad)).rejects.toThrow();
  });

  it("throws for mismatched AAD", async () => {
    const keypair = await generateOperatorKeypair();
    const bundle = await sealToRecipient(keypair.publicKey, message, aad);
    const wrongAad = new TextEncoder().encode("different mandate");
    await expect(openSealed(keypair.privateKey, bundle, wrongAad)).rejects.toThrow();
  });

  it("uses a fresh ephemeral key for each seal", async () => {
    const keypair = await generateOperatorKeypair();
    const first = await sealToRecipient(keypair.publicKey, message, aad);
    const second = await sealToRecipient(keypair.publicKey, message, aad);
    expect(first).not.toBe(second);
  });
});
