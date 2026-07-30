// Telegram account-linking tokens — one-time /start deep-link token
// minted by POST /v1/telegram/link, consumed by the webhook. 15-minute
// TTL, single-use. Shape mirrors PairingToken (auth/pairing-token.ts).

export interface TelegramLinkTokenRecord {
  token: string;
  accountId: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface TelegramLinkTokenStore {
  create(accountId: string, token: string, expiresAt: Date): Promise<void>;
  // Single-use: returns the linked account id and deletes the token if
  // it exists and hasn't expired; null otherwise (unknown/expired token).
  consume(token: string, now: Date): Promise<string | null>;
  // Retention sweep — deletes rows past expires_at regardless of use.
  deleteExpired(now: Date): Promise<number>;
}

export class InMemoryTelegramLinkTokenStore implements TelegramLinkTokenStore {
  private readonly records = new Map<string, TelegramLinkTokenRecord>();
  private readonly now: () => Date;

  constructor(now?: () => Date) {
    this.now = now ?? (() => new Date());
  }

  async create(accountId: string, token: string, expiresAt: Date): Promise<void> {
    this.records.set(token, { token, accountId, createdAt: this.now(), expiresAt });
  }

  async consume(token: string, now: Date): Promise<string | null> {
    const record = this.records.get(token);
    if (record === undefined || record.expiresAt <= now) return null;
    this.records.delete(token);
    return record.accountId;
  }

  async deleteExpired(now: Date): Promise<number> {
    let deleted = 0;
    for (const [token, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(token);
        deleted++;
      }
    }
    return deleted;
  }
}
