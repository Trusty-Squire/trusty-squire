import { createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import type { InteractiveElement } from "./browser.js";

export const OBSERVE_V2_MAX_WIRE_BYTES = 4_096;
export const OBSERVE_V2_MAX_TOKENS = 1_024;

export type SafeRoleV2 =
  | "button"
  | "link"
  | "textbox"
  | "select"
  | "checkbox"
  | "radio"
  | "tab"
  | "menuitem"
  | "file";
export type SafeIntentV2 =
  | "search"
  | "close"
  | "next"
  | "previous"
  | "submit"
  | "continue"
  | "login"
  | "signup"
  | "add_to_cart"
  | "checkout"
  | "payment";

export interface SafeControlV2 {
  ref: string;
  role: SafeRoleV2;
  state?: string;
  visibility: "viewport" | "near";
  action?: SafeIntentV2;
  frame: "main" | "same_origin" | "cross_origin";
}

export interface BrowserUseSelectedNode {
  backend_node_id: number;
  tag: string;
  role: string | null;
  /** Process-internal only. Never copy this into a safe row or a log. */
  name: string;
}

export interface SafeObservationIndexV2 {
  generation: number;
  rows: SafeControlV2[];
  byRef: Map<string, string>;
  expiresAt: number;
}

const INTENTS: ReadonlyArray<[SafeIntentV2, RegExp]> = [
  ["add_to_cart", /add\s+(?:to\s+)?(?:cart|bag|basket)/i],
  ["checkout", /checkout|view\s+(?:cart|bag|basket)/i],
  ["payment", /pay(?:ment)?|card/i],
  ["signup", /sign\s*up|create\s+(?:account|workspace)|register/i],
  ["login", /log\s*in|sign\s*in|continue\s+with/i],
  ["search", /search|find/i],
  ["close", /close|dismiss|cancel|no\s+thanks/i],
  ["next", /next/i],
  ["previous", /previous|back/i],
  ["submit", /submit|save|create|send/i],
  ["continue", /continue|proceed|start|accept|allow/i],
];

function candidateText(el: InteractiveElement): string {
  return [
    el.visibleText,
    el.labelText,
    el.ariaLabel,
    el.iconLabel,
    el.title,
    el.placeholder,
    el.name,
    el.id,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
}

function roleOf(el: InteractiveElement): SafeRoleV2 | null {
  const role = (el.role ?? "").toLowerCase();
  const type = (el.type ?? "").toLowerCase();
  if (type === "file") return "file";
  if (type === "checkbox" || role === "checkbox") return "checkbox";
  if (type === "radio" || role === "radio") return "radio";
  if (el.tag === "select" || role === "combobox" || role === "listbox") return "select";
  if (el.tag === "input" || el.tag === "textarea" || role === "textbox") return "textbox";
  if (el.tag === "a" || role === "link") return "link";
  if (role === "tab") return "tab";
  if (role === "menuitem" || role === "option") return "menuitem";
  if (el.tag === "button" || role === "button" || (el.topmost !== null && el.topmost !== undefined)) {
    return "button";
  }
  return null;
}

function stateOf(el: InteractiveElement): string | undefined {
  // A compact code-owned bitset: c=checked, u=unchecked, d=disabled-ish,
  // r=required.  It is deliberately not a page-provided string.
  let state = "";
  if (el.checked === true) state += "c";
  else if (el.checked === false) state += "u";
  if (el.sealed === true) state += "d";
  return state || undefined;
}

function intentOf(el: InteractiveElement): SafeIntentV2 | undefined {
  const text = candidateText(el);
  return INTENTS.find(([, expression]) => expression.test(text))?.[0];
}

function frameOf(el: InteractiveElement, pageOrigin: string): SafeControlV2["frame"] {
  if (el.frameOrigin === null || el.frameOrigin === undefined) return "main";
  return el.frameOrigin === pageOrigin ? "same_origin" : "cross_origin";
}

function upstreamSelected(el: InteractiveElement, selected: readonly BrowserUseSelectedNode[]): boolean {
  const tag = el.tag.toLowerCase();
  const role = (el.role ?? "").toLowerCase();
  const text = candidateText(el).replace(/\s+/g, " ").trim().toLowerCase();
  return selected.some((node) => {
    if (node.tag.toLowerCase() !== tag) return false;
    if (role.length > 0 && node.role !== null && node.role.toLowerCase() !== role) return false;
    // The upstream serializer's selector map is authoritative. Name matching
    // maps it onto TS's stable action reference without ever emitting the name.
    const name = node.name.replace(/\s+/g, " ").trim().toLowerCase();
    return name.length === 0 || text.length === 0 || name === text || name.includes(text) || text.includes(name);
  });
}

export function safeV2Ref(secret: Buffer, legacyRef: string): string {
  return `@e:${createHmac("sha256", secret).update(legacyRef).digest("base64url").slice(0, 18)}`;
}

export function buildSafeControlsV2(args: {
  elements: readonly InteractiveElement[];
  legacyRefs: ReadonlyMap<InteractiveElement, string>;
  secret: Buffer;
  pageOrigin: string;
  selected: readonly BrowserUseSelectedNode[];
}): { rows: SafeControlV2[]; byRef: Map<string, string> } {
  const rows: Array<{ row: SafeControlV2; priority: number }> = [];
  const byRef = new Map<string, string>();
  for (const el of args.elements) {
    if (el.visible !== true || el.topmost === false) continue;
    const role = roleOf(el);
    const legacy = args.legacyRefs.get(el);
    if (role === null || legacy === undefined || !upstreamSelected(el, args.selected)) continue;
    const ref = safeV2Ref(args.secret, legacy);
    byRef.set(ref, legacy);
    const state = stateOf(el);
    const action = intentOf(el);
    const row: SafeControlV2 = {
      ref,
      role,
      visibility: el.inViewport ? "viewport" : "near",
      frame: frameOf(el, args.pageOrigin),
      ...(state === undefined ? {} : { state }),
      ...(action === undefined ? {} : { action }),
    };
    rows.push({ row, priority: (el.inViewport ? 0 : 10) + (role === "button" ? 0 : 1) });
  }
  rows.sort((a, b) => a.priority - b.priority || a.row.ref.localeCompare(b.row.ref));
  return { rows: rows.map(({ row }) => row), byRef };
}

export function encodeV2Page(args: {
  sessionId: string;
  generation: number;
  rows: readonly SafeControlV2[];
  cursorFor: (offset: number) => string;
  offset?: number;
}): { payload: Record<string, unknown>; nextOffset: number } {
  const offset = args.offset ?? 0;
  const visible: SafeControlV2[] = [];
  for (let index = offset; index < args.rows.length; index += 1) {
    const candidate = args.rows[index]!;
    const remainder = args.rows.length - (index + 1);
    const payload: Record<string, unknown> = {
      format: "compact-v2",
      session_id: args.sessionId,
      generation: args.generation,
      safe_table: [...visible, candidate],
      ...(remainder > 0 ? { overflow: { remaining: remainder, next_cursor: args.cursorFor(index + 1) } } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > OBSERVE_V2_MAX_WIRE_BYTES) break;
    visible.push(candidate);
  }
  const nextOffset = offset + visible.length;
  const remaining = args.rows.length - nextOffset;
  const payload: Record<string, unknown> = {
    format: "compact-v2",
    session_id: args.sessionId,
    generation: args.generation,
    safe_table: visible,
    ...(remaining > 0 ? { overflow: { remaining, next_cursor: args.cursorFor(nextOffset) } } : {}),
  };
  // The fixed fields are deliberately tiny, so failure means a hostilely long
  // session id/cursor. Fail closed rather than exceeding the wire contract.
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > OBSERVE_V2_MAX_WIRE_BYTES) {
    throw new Error("compact-v2 budget metadata exceeded");
  }
  return { payload, nextOffset };
}
