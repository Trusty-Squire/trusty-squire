// In-session secret slots: values extracted in-session are held in the
// Session's secretSlots map so a later type_secret can enter them into another
// site's form without the host having to relay them. This is a transfer
// convenience, not a read seal — observations show whatever the page renders,
// including a slotted value. The raw value stays in the Session and is never
// returned to the host; the stash path hands back only a handle + masked
// preview. Extends the write-only-vault moat to in-session credential
// transfer.
import { audit, sessionForCall } from "./lifecycle.js";

// Mask a secret for a host-facing preview: keep a short prefix + last few
// chars, redact the middle. Never reveals enough to reconstruct the value.
export function maskSecretValue(value: string): string {
  const v = value.trim();
  if (v.length <= 8) return "••••";
  const head = v.slice(0, Math.min(6, v.length - 4));
  const tail = v.slice(-3);
  return `${head}••••${tail}`;
}

export interface SlotHandle {
  slot: string;
  preview: string;
  length: number;
}

// Stash a secret into a session-local slot and return ONLY a handle + masked
// preview.
export function stashSecretSlot(sessionId: string, slot: string, value: string): SlotHandle {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  session.secretSlots.set(slot, value);
  audit(sessionId, "secret_slot_set", { slot, length: value.length });
  return { slot, preview: maskSecretValue(value), length: value.length };
}

// Internal MCP tool bridge: read a sealed slot so the tool layer can persist a
// signup password to the vault after the service account is created. Never
// expose this value in a tool response or recipe trace.
export function readSecretSlotValue(sessionId: string, slot: string): string {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const value = session.secretSlots.get(slot);
  if (value === undefined) throw new Error(`no sealed slot named "${slot}"`);
  return value;
}
