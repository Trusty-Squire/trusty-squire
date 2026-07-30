import { describe, expect, it } from "vitest";
import type { ApiPrismaClient } from "../api-prisma-client.js";
import { PrismaCredentialStore } from "../prisma-credential-store.js";

function p1017(): Error & { code: string } {
  return Object.assign(new Error("Server has closed the connection."), { code: "P1017" });
}

describe("PrismaCredentialStore", () => {
  it("findActive() reconnects and retries once after Prisma P1017", async () => {
    let reads = 0;
    let disconnects = 0;
    const prisma = {
      credential: {
        async findFirst() {
          reads += 1;
          if (reads === 1) throw p1017();
          return null;
        },
      },
      async $disconnect() {
        disconnects += 1;
      },
    } as unknown as ApiPrismaClient;
    const store = new PrismaCredentialStore(prisma);

    await expect(store.findActive("vault://acct/cred")).resolves.toBeNull();
    expect(reads).toBe(2);
    expect(disconnects).toBe(1);
  });

  it("findActive() surfaces a repeated Prisma P1017 after one reconnect", async () => {
    let reads = 0;
    let disconnects = 0;
    const prisma = {
      credential: {
        async findFirst() {
          reads += 1;
          throw p1017();
        },
      },
      async $disconnect() {
        disconnects += 1;
      },
    } as unknown as ApiPrismaClient;
    const store = new PrismaCredentialStore(prisma);

    await expect(store.findActive("vault://acct/cred")).rejects.toMatchObject({
      code: "P1017",
    });
    expect(reads).toBe(2);
    expect(disconnects).toBe(1);
  });
});
