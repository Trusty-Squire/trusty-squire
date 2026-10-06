import { setTimeout as delay } from "node:timers/promises";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ApiClient } from "./api-client.js";

type ApprovalKind = "payment" | "credential_fetch" | "credential_mutation" | "card_mutation";
type Decision = "approved" | "denied";
type PendingApproval = { id: string; kind: ApprovalKind; expiresAt: number };

function approvalKind(tool: string): ApprovalKind | null {
  if (tool === "fetch_credential") return "credential_fetch";
  if (tool === "edit_credential" || tool === "delete_credential") return "credential_mutation";
  if (tool === "edit_payment_card") return "card_mutation";
  if (tool === "inject_card" || tool.startsWith("operate_")) return "payment";
  return null;
}

/** Find every pending approval in the returned tool envelope, including operate_drive.payment. */
export function pendingApprovals(tool: string, result: unknown): PendingApproval[] {
  const kind = approvalKind(tool);
  if (kind === null) return [];
  const found: PendingApproval[] = [];
  const visit = (value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (
      (record.status === "approval_pending" || record.status === "pending_approval") &&
      typeof record.approval_id === "string" &&
      typeof record.expires_at === "string"
    ) {
      const expiresAt = Date.parse(record.expires_at);
      if (Number.isFinite(expiresAt)) {
        found.push({ id: record.approval_id, kind, expiresAt });
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(result);
  return found;
}

/** Shared by the broker's MCP sockets: the first pending result owns an ID. */
export class ApprovalDecisionClaims {
  private readonly claimed = new Map<string, NodeJS.Timeout>();

  claim(id: string, expiresAt: number): boolean {
    if (this.claimed.has(id) || expiresAt <= Date.now()) return false;
    const timer = setTimeout(() => this.claimed.delete(id), expiresAt - Date.now());
    timer.unref();
    this.claimed.set(id, timer);
    return true;
  }

  close(): void {
    for (const timer of this.claimed.values()) clearTimeout(timer);
    this.claimed.clear();
  }
}

async function readDecision(
  api: ApiClient,
  approval: PendingApproval,
  signal: AbortSignal,
): Promise<Decision | "pending" | "terminal"> {
  const holdMs = 15_000;
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(holdMs + 5_000)]);
  const record =
    approval.kind === "payment"
      ? await api.getPaymentApproval(
          approval.id,
          "wait-decision-peek",
          holdMs,
          holdMs + 5_000,
          signal,
        )
      : approval.kind === "credential_fetch"
        ? await api.getCredentialFetchApprovalStatus(approval.id, requestSignal, holdMs)
        : approval.kind === "credential_mutation"
          ? await api.getCredentialMutationApproval(approval.id, requestSignal, holdMs)
          : await api.getCardMutationApproval(approval.id, requestSignal, holdMs);
  if (record.status === "approved" || record.status === "consumed") return "approved";
  if (record.status === "denied") return "denied";
  if (record.status === "pending") return "pending";
  return "terminal";
}

/** One instance belongs to one MCP socket, so notifications cannot cross clients. */
export class ApprovalDecidedNotifier {
  private readonly watches = new Map<string, AbortController>();

  constructor(
    private readonly server: Server,
    private readonly connectionSignal?: AbortSignal,
    private readonly claims = new ApprovalDecisionClaims(),
  ) {
    connectionSignal?.addEventListener("abort", () => this.close(), { once: true });
  }

  watch(tool: string, result: unknown, api: ApiClient): void {
    for (const approval of pendingApprovals(tool, result)) {
      if (this.connectionSignal?.aborted || !this.claims.claim(approval.id, approval.expiresAt))
        continue;
      const controller = new AbortController();
      this.watches.set(approval.id, controller);
      void this.run(approval, api, controller).finally(() => {
        if (this.watches.get(approval.id) === controller) this.watches.delete(approval.id);
      });
    }
  }

  close(): void {
    for (const controller of this.watches.values()) controller.abort();
    this.watches.clear();
  }

  private async run(
    approval: PendingApproval,
    api: ApiClient,
    controller: AbortController,
  ): Promise<void> {
    const signal = controller.signal;
    // Give the tool response a turn to reach its originating socket first.
    await new Promise<void>((resolve) => setImmediate(resolve));
    while (!signal.aborted && Date.now() < approval.expiresAt) {
      let decision: Decision | "pending" | "terminal";
      try {
        decision = await readDecision(api, approval, signal);
      } catch {
        // An unavailable status read is transient. The approval's own expiry
        // remains the bound; the watcher neither changes nor consumes it.
        try {
          await delay(Math.min(3_000, approval.expiresAt - Date.now()), undefined, {
            signal,
            ref: false,
          });
        } catch {
          return;
        }
        continue;
      }
      if (signal.aborted || decision === "terminal") return;
      if (decision === "pending") continue;
      controller.abort(); // fence repeated results before writing the one frame
      try {
        await this.server.notification({
          method: "notifications/approval_decided",
          params: { approval_id: approval.id, status: decision },
        } as Parameters<Server["notification"]>[0]);
      } catch {
        // The original MCP connection has closed; there is no other recipient.
      }
      return;
    }
  }
}
