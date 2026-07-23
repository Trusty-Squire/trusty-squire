import { describe, expect, it } from "vitest";
import { decryptCard, encryptCard } from "../e2e.js";

const card = {
  pan: "4242424242424242",
  exp_month: 12,
  exp_year: 2030,
  name: "Synthetic Cardholder",
  zip: "10001",
  cvv: "123",
};

describe("encryptCard / decryptCard", () => {
  it("round-trips card data", async () => {
    const blob = await encryptCard("correct horse battery staple", card);
    await expect(decryptCard("correct horse battery staple", blob)).resolves.toEqual(card);
  });

  it("throws for the wrong passphrase", async () => {
    const blob = await encryptCard("correct passphrase", card);
    await expect(decryptCard("wrong passphrase", blob)).rejects.toThrow();
  });

  it("throws for tampered ciphertext", async () => {
    const blob = await encryptCard("passphrase", card);
    const ciphertext = Uint8Array.from(atob(blob.ct), (character) => character.charCodeAt(0));
    ciphertext[0] = ciphertext[0]! ^ 1;
    const tampered = {
      ...blob,
      ct: btoa(String.fromCharCode(...ciphertext)),
    };

    await expect(decryptCard("passphrase", tampered)).rejects.toThrow();
  });

  it("uses a new salt and IV for each encryption", async () => {
    const first = await encryptCard("passphrase", card);
    const second = await encryptCard("passphrase", card);
    expect(first.salt).not.toBe(second.salt);
    expect(first.iv).not.toBe(second.iv);
  });
});
