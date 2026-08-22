import { describe, expect, it } from "vitest";
import type { ApiPrismaClient } from "../api-prisma-client.js";
import { PrismaCredentialStore } from "../prisma-credential-store.js";

function p1017(): Error & { code: string } {
  return Object.assign(new Error("Server has closed the connection."), { code: "P1017" });
}

function p2002(): Error & { code: string } {
  return Object.assign(new Error("Unique constraint failed."), { code: "P2002" });
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

  it("isActive() reconnects and retries once after Prisma P1017", async () => {
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

    await expect(store.isActive("vault://acct/cred", "acct")).resolves.toBe(false);
    expect(reads).toBe(2);
    expect(disconnects).toBe(1);
  });

  it("maps the active service-label unique index violation to a slot conflict", async () => {
    const prisma = {
      credential: {
        async updateMany() {
          throw p2002();
        },
      },
    } as unknown as ApiPrismaClient;
    const store = new PrismaCredentialStore(prisma);

    await expect(
      store.updateMetadata(
        "vault://acct/cred",
        { label: "old", allowed_hosts: [], metadata: { service: "OpenAI" } },
        { label: "shared" },
      ),
    ).resolves.toBe("conflict");
  });
});
