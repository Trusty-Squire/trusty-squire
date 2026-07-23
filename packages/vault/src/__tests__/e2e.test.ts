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
    const key = crypto.getRandomValues(new Uint8Array(32));
    const blob = await encryptCard(key, card);
    await expect(decryptCard(key, blob)).resolves.toEqual(card);
  });

  it("throws for the wrong key", async () => {
    const blob = await encryptCard(crypto.getRandomValues(new Uint8Array(32)), card);
    const wrongKey = crypto.getRandomValues(new Uint8Array(32));
    await expect(decryptCard(wrongKey, blob)).rejects.toThrow();
  });

  it("throws for tampered ciphertext", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const blob = await encryptCard(key, card);
    const ciphertext = Uint8Array.from(atob(blob.ct), (character) => character.charCodeAt(0));
    ciphertext[0] = ciphertext[0]! ^ 1;
    const tampered = {
      ...blob,
      ct: btoa(String.fromCharCode(...ciphertext)),
    };

    await expect(decryptCard(key, tampered)).rejects.toThrow();
  });

  it("validates the envelope", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const blob = await encryptCard(key, card);
    const invalid = [
      { ...blob, v: 2 },
      { ...blob, cipher: "unsupported" },
      { ...blob, iv: btoa(String.fromCharCode(...new Uint8Array(11))) },
      { ...blob, ct: btoa(String.fromCharCode(...new Uint8Array(15))) },
    ];
    for (const candidate of invalid) {
      await expect(decryptCard(key, candidate as unknown as typeof blob)).rejects.toThrow(
        "Invalid encrypted card",
      );
    }
  });

  it("uses a new IV for each encryption", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const first = await encryptCard(key, card);
    const second = await encryptCard(key, card);
    expect(first.iv).not.toBe(second.iv);
  });
});
