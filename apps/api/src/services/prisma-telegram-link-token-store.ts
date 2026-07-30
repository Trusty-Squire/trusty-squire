import type { ApiPrismaClient } from "./api-prisma-client.js";
import type { TelegramLinkTokenStore } from "./in-memory-telegram-link-token-store.js";

export class PrismaTelegramLinkTokenStore implements TelegramLinkTokenStore {
  constructor(private readonly prisma: ApiPrismaClient) {}

  async create(accountId: string, token: string, expiresAt: Date): Promise<void> {
    await this.prisma.telegramLinkToken.create({
      data: { token, account_id: accountId, expires_at: expiresAt },
    });
  }

  async consume(token: string, now: Date): Promise<string | null> {
    const row = await this.prisma.telegramLinkToken.findUnique({ where: { token } });
    if (row === null || row.expires_at <= now) return null;
    await this.prisma.telegramLinkToken.deleteMany({ where: { token } });
    return row.account_id;
  }

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.prisma.telegramLinkToken.deleteMany({
      where: { expires_at: { lt: now } },
    });
    return result.count;
  }
}
