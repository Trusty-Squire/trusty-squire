import { randomUUID } from "node:crypto";
import type { Dialog } from "playwright";

type NativeDialogHandle = Pick<Dialog, "type" | "message" | "defaultValue" | "accept" | "dismiss">;
interface DialogPage {
  on(event: "dialog", listener: (dialog: NativeDialogHandle) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  off(event: "dialog", listener: (dialog: NativeDialogHandle) => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

export const NATIVE_DIALOG_TIMEOUT_MS = 120_000;
export interface NativeDialogEvidence {
  kind: "native_dialog";
  id: string;
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  text: string;
  default_value: string;
  options: Array<{ ref: string; action: "accept" | "dismiss"; label: string }>;
  expires_at: string;
}

/** Dialogs belong to a session's owned tabs, never every tab in its shared context. */
export class NativeDialogs {
  private readonly pending = new Map<
    string,
    {
      page: DialogPage;
      dialog: NativeDialogHandle;
      evidence: NativeDialogEvidence;
      timer: NodeJS.Timeout;
      answering: boolean;
    }
  >();
  private readonly subscriptions = new Map<DialogPage, () => void>();
  private readonly listeners = new Set<() => void>();
  private readonly notices: string[] = [];
  private openedRevision = 0;
  get revision(): number {
    return this.openedRevision;
  }

  constructor(private readonly timeoutMs = NATIVE_DIALOG_TIMEOUT_MS) {}

  watch(page: DialogPage): void {
    if (this.subscriptions.has(page)) return;
    const opened = (dialog: NativeDialogHandle): void => {
      const id = randomUUID();
      const type = dialog.type();
      if (type !== "alert" && type !== "confirm" && type !== "prompt" && type !== "beforeunload")
        return;
      const evidence: NativeDialogEvidence = {
        kind: "native_dialog",
        id,
        type,
        text: dialog.message(),
        default_value: dialog.defaultValue(),
        options: [
          { ref: `${id}:accept`, action: "accept", label: "OK" },
          { ref: `${id}:dismiss`, action: "dismiss", label: "Cancel" },
        ],
        expires_at: new Date(Date.now() + this.timeoutMs).toISOString(),
      };
      const timer = setTimeout(() => {
        void this.answer(id, "dismiss")
          .then(() => {
            this.notices.push(
              `Native ${evidence.type} dialog ${id} dismissed after timeout: ${evidence.text}`,
            );
            this.notices.splice(0, Math.max(0, this.notices.length - 8));
            this.emit();
          })
          .catch(() => undefined);
      }, this.timeoutMs);
      timer.unref();
      this.openedRevision += 1;
      this.pending.set(id, { page, dialog, evidence, timer, answering: false });
      this.emit();
    };
    const closed = (): void => {
      for (const [id, entry] of this.pending)
        if (entry.page === page) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
        }
      page.off("dialog", opened);
      page.off("close", closed);
      this.subscriptions.delete(page);
      this.emit();
    };
    page.on("dialog", opened);
    page.on("close", closed);
    this.subscriptions.set(page, closed);
  }

  evidence(): NativeDialogEvidence[] {
    return [...this.pending.values()].map((entry) => entry.evidence);
  }
  timeoutNotices(): string[] {
    return [...this.notices];
  }
  get blocked(): boolean {
    return this.pending.size > 0;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** Native dialogs suspend page evaluation; their browser evidence must win the read. */
  async read<T>(read: () => Promise<T>, onDialog: () => T): Promise<T> {
    if (this.blocked) return onDialog();
    let wake!: (value: T) => void;
    const opened = new Promise<T>((resolve) => {
      wake = resolve;
    });
    const unsubscribe = this.subscribe(() => {
      if (this.blocked) wake(onDialog());
    });
    try {
      return await Promise.race([read(), opened]);
    } finally {
      unsubscribe();
    }
  }

  /** Return control while the dispatched browser action waits for a dialog reply. */
  async interrupt(action: () => Promise<void>): Promise<void> {
    if (this.blocked) throw new Error("native_dialog_pending: answer the observed dialog first");
    await this.read(action, () => undefined);
  }

  async answer(id: string, action: "accept" | "dismiss", text?: string): Promise<void> {
    const entry = this.pending.get(id);
    if (entry === undefined || entry.answering) throw new Error("stale_native_dialog");
    if (text !== undefined && (entry.evidence.type !== "prompt" || action !== "accept"))
      throw new Error("prompt_text_requires_prompt_accept");
    // Consume before awaiting so two viewers cannot answer the same dialog.
    entry.answering = true;
    clearTimeout(entry.timer);
    try {
      if (action === "accept")
        await entry.dialog.accept(
          text ?? (entry.evidence.type === "prompt" ? entry.dialog.defaultValue() : undefined),
        );
      else await entry.dialog.dismiss();
    } finally {
      this.pending.delete(id);
      this.emit();
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.pending.keys()].map((id) => this.answer(id, "dismiss")));
    for (const dispose of this.subscriptions.values()) dispose();
    this.listeners.clear();
  }
}
