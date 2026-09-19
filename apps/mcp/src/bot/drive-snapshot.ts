// Drive-loop snapshot. Modeled on browser-use/jev-ultrafast snapshot.js (MIT).
// One in-page evaluate: visible-text labels, all headings, a fingerprint, and a
// node registry keyed by our refs. Used only inside operate_drive.

import type { Frame, Page } from "playwright";
import type { Observation } from "./provision-session.js";

type SnapshotRow = [string, string, string?];

export const DRIVE_SNAPSHOT_CREDIT =
  "Drive snapshot evaluate adapted from browser-use/jev-ultrafast snapshot.js (MIT).";

export const DRIVE_SNAPSHOT_MAX_ELEMENTS = 250;

export interface DriveSnapshotOption {
  value: string;
  label: string;
}

export interface DriveSnapshotElement {
  ref: string;
  role: string;
  label: string;
  value?: string;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  required?: boolean;
  offscreen?: boolean;
  operations: Array<"click" | "fill" | "select">;
  options?: DriveSnapshotOption[];
  frameOrdinal: number;
}

export interface DriveSnapshot {
  url: string;
  title: string;
  headings: string[];
  text: string;
  fingerprint: string;
  documentEpoch: string;
  elements: DriveSnapshotElement[];
  omittedValues: number;
  scriptMs: number;
  wallMs: number;
}

interface DriveSnapshotArg {
  omitValueRefs: string[];
  frameOrdinal: number;
  maxElements: number;
}

type DriveInPageSnapshot = {
  url: string;
  title: string;
  headings: string[];
  text: string;
  fingerprint: string;
  documentEpoch: string;
  elements: DriveSnapshotElement[];
  omittedValues: number;
  scriptMs: number;
};

const FIELD_FROM_LABEL: Array<{ test: RegExp; field: string }> = [
  { test: /e-?mail/, field: "email" },
  { test: /first\s*name|given\s*name/, field: "first_name" },
  { test: /last\s*name|surname|family\s*name/, field: "last_name" },
  { test: /company|organization|organisation/, field: "company" },
  { test: /search|query|\bfind\b/, field: "search" },
  { test: /password/, field: "password" },
  { test: /phone|tel|mobile/, field: "phone" },
  { test: /address/, field: "address" },
  { test: /\bcity\b/, field: "city" },
  { test: /\bstate\b|province|region/, field: "state" },
  { test: /zip|postal/, field: "zip" },
  { test: /country/, field: "country" },
  { test: /card\s*number|\bpan\b|credit\s*card/, field: "payment" },
  { test: /cvv|cvc|cid|security\s*code/, field: "cvv" },
  { test: /verification\s*code|\botp\b|one[-\s]?time/, field: "otp" },
];

export function inferFieldFromLabel(label: string, role: string): string | undefined {
  const hay = label.toLowerCase();
  const words = hay.split(/[^a-z0-9]+/).filter((word) => word.length > 0);
  if (role === "searchbox") return "search";
  for (const entry of FIELD_FROM_LABEL) {
    const geographic = ["city", "state", "zip", "country", "address"].includes(entry.field);
    if (geographic && words.length > 4) continue;
    if (entry.test.test(hay)) return entry.field;
  }
  return undefined;
}

export function driveRowsFromSnapshot(snapshot: DriveSnapshot): SnapshotRow[] {
  const rows: SnapshotRow[] = [];
  const optionParents = new Map<string, DriveSnapshotElement[]>();
  for (const element of snapshot.elements) {
    if (element.role !== "option") continue;
    const key = element.frameOrdinal.toString();
    const list = optionParents.get(key) ?? [];
    list.push(element);
    optionParents.set(key, list);
  }
  const optionOrdinal = new Map<string, { index: number; total: number }>();
  for (const siblings of optionParents.values()) {
    if (siblings.length < 3) continue;
    siblings.forEach((element, index) => {
      optionOrdinal.set(element.ref, { index: index + 1, total: siblings.length });
    });
  }
  for (const element of snapshot.elements) {
    const facts: string[] = [];
    const label = element.label.replace(/\|/g, " ").trim();
    if (label.length > 0) facts.push(label);
    const field = inferFieldFromLabel(element.label, element.role);
    if (field !== undefined) facts.push(`f=${field}`);
    const states: string[] = [];
    if (element.required === true) states.push("r");
    if (element.disabled === true) states.push("d");
    if (element.checked === true) states.push("c");
    if (element.checked === false && (element.role === "checkbox" || element.role === "radio")) {
      states.push("u");
    }
    if (states.length > 0) facts.push(`s=${states.join("")}`);
    if (element.offscreen === true) facts.push("v=offscreen");
    if (element.value !== undefined && element.value.length > 0) {
      facts.push(`n=${element.value.replace(/\|/g, " ").slice(0, 80)}`);
    }
    const choice = optionOrdinal.get(element.ref);
    if (choice !== undefined) facts.push(`q=${choice.index}/${choice.total}`);
    const roleLetter =
      element.role === "button"
        ? "b"
        : element.role === "link" || element.role === "option"
          ? "l"
          : element.role === "textbox" || element.role === "searchbox" || element.role === "spinbutton"
            ? "t"
            : element.role === "combobox" && element.operations.includes("select")
              ? "s"
              : element.role === "checkbox"
                ? "c"
                : element.role === "radio"
                  ? "r"
                  : element.role === "tab"
                    ? "tb"
                    : element.role === "menuitem"
                      ? "m"
                      : element.role;
    rows.push(facts.length === 0 ? [element.ref, roleLetter] : [element.ref, roleLetter, facts.join("|")]);
  }
  return rows;
}

export function snapshotSelectOptions(snapshot: DriveSnapshot): Map<string, string[]> {
  const options = new Map<string, string[]>();
  for (const element of snapshot.elements) {
    if (element.options === undefined || element.options.length === 0) continue;
    const texts = element.options.map((option) => option.label).filter((text) => text.length > 0);
    if (texts.length === 0) continue;
    options.set(element.ref, texts);
    const label = element.label.trim().toLowerCase();
    if (label.length > 0) options.set(label, texts);
  }
  return options;
}

export function snapshotToObservation(
  snapshot: DriveSnapshot,
  sessionId: string,
  rows: readonly SnapshotRow[],
): Observation {
  return {
    session_id: sessionId,
    url: snapshot.url,
    safe_table: rows as unknown as NonNullable<Observation["safe_table"]>,
    dom: snapshot.text,
    semantic: {
      title: snapshot.title,
      headings: snapshot.headings,
    },
  };
}

function inPageSnapshot(arg: DriveSnapshotArg): DriveInPageSnapshot | null {
  const scriptStarted = performance.now();
  if (document.body === null) return null;
  type DriveCache = {
    ids: WeakMap<Element, number>;
    nodes: Map<string, Element>;
    next: number;
  };
  const root = window as Window & { __tsDriveRegistry?: DriveCache };
  const cache: DriveCache = root.__tsDriveRegistry ?? {
    ids: new WeakMap<Element, number>(),
    nodes: new Map<string, Element>(),
    next: 1,
  };
  root.__tsDriveRegistry = cache;
  const omit = new Set(arg.omitValueRefs);
  const frameOrdinal = arg.frameOrdinal;
  const identity = (element: Element): string => {
    let id = cache.ids.get(element);
    if (id === undefined) {
      id = cache.next;
      cache.next += 1;
      cache.ids.set(element, id);
    }
    const ref = `@e:f${frameOrdinal}d${id}`;
    cache.nodes.set(ref, element);
    return ref;
  };
  for (const [ref, element] of cache.nodes) {
    if (!element.isConnected) cache.nodes.delete(ref);
  }
  const safe = (element: Element): boolean => {
    if (!(element instanceof HTMLInputElement)) return true;
    return !["password", "file", "hidden"].includes(element.type);
  };
  const visible = (element: Element): boolean => {
    if (element.closest('[aria-hidden="true"],[inert]') !== null) return false;
    if (typeof element.checkVisibility === "function") {
      return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };
  const name = (element: Element | null, seen = new Set<Element>()): string => {
    if (element === null || seen.has(element)) return "";
    seen.add(element);
    const labelledBy = (element.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => name(document.getElementById(id), seen))
      .filter((part) => part.length > 0)
      .join(" ");
    if (labelledBy.length > 0) return labelledBy;
    const aria = element.getAttribute("aria-label");
    if (aria !== null && aria.trim().length > 0) return aria.trim();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element instanceof HTMLButtonElement) {
      const labels = element.labels === null ? [] : Array.from(element.labels);
      const fromLabels = labels
        .map((label) => name(label, seen))
        .filter((part) => part.length > 0)
        .join(" ");
      if (fromLabels.length > 0) return fromLabels;
    }
    if (element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type) && element.value.length > 0) {
      return element.value;
    }
    const alt = element.getAttribute("alt");
    if (alt !== null && alt.trim().length > 0) return alt.trim();
    if (element.tagName !== "INPUT") {
      const child = Array.from(element.childNodes)
        .map((node) => {
          if (node.nodeType === 3) return (node.textContent ?? "").trim();
          if (node.nodeType === 1 && node instanceof Element && node.getAttribute("aria-hidden") !== "true") {
            return name(node, seen);
          }
          return "";
        })
        .filter((part) => part.length > 0)
        .join(" ")
        .trim();
      if (child.length > 0) return child;
    }
    const title = element.getAttribute("title");
    if (title !== null && title.trim().length > 0) return title.trim();
    const placeholder = element.getAttribute("placeholder");
    if (placeholder !== null && placeholder.trim().length > 0) return placeholder.trim();
    return "";
  };
  const roles = [
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "tab",
    "menuitem",
    "menuitemradio",
    "option",
    "gridcell",
    "combobox",
    "textbox",
    "searchbox",
    "spinbutton",
  ];
  const selector =
    'a[href],a.suggestion-link,button,input,textarea,select,summary,[contenteditable="true"],' +
    roles.map((role) => `[role="${role}"]`).join(",");
  const roleOf = (element: Element): string | null => {
    const explicit = element.getAttribute("role");
    if (explicit !== null && roles.includes(explicit)) return explicit;
    if (element.tagName === "BUTTON" || element.tagName === "SUMMARY") return "button";
    if (element.tagName === "A" || element.classList.contains("suggestion-link")) return "link";
    if (element.tagName === "SELECT") return "combobox";
    if (element.tagName === "TEXTAREA" || (element instanceof HTMLElement && element.isContentEditable)) {
      return "textbox";
    }
    if (element instanceof HTMLInputElement) {
      if (["checkbox", "radio"].includes(element.type)) return element.type;
      if (["button", "submit", "reset", "image"].includes(element.type)) return "button";
      if (element.type === "search") return "searchbox";
      if (element.type === "number") return "spinbutton";
      if (["text", "email", "url", "tel"].includes(element.type)) return "textbox";
    }
    return null;
  };
  const inView: DriveSnapshotElement[] = [];
  const offscreenControls: DriveSnapshotElement[] = [];
  let omittedValues = 0;
  for (const element of Array.from(document.querySelectorAll(selector))) {
    if (!safe(element) || !visible(element)) continue;
    const role = roleOf(element);
    if (role === null) continue;
    if (role === "gridcell" && element.querySelector("button,[role='button']") !== null) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const inViewport =
      rect.bottom > 0 &&
      rect.top < innerHeight &&
      rect.right > 0 &&
      rect.left < innerWidth;
    const keepOffscreen =
      role === "button" ||
      role === "textbox" ||
      role === "searchbox" ||
      role === "spinbutton" ||
      role === "checkbox" ||
      role === "radio" ||
      role === "combobox" ||
      element.tagName === "SELECT";
    const pinned =
      element.closest(
        "header,nav,footer,[role='banner'],[role='navigation'],[role='contentinfo']",
      ) !== null;
    if (!inViewport && !keepOffscreen && !pinned) continue;
    const ref = identity(element);
    const label = name(element) || role;
    const disabled =
      element.matches(":disabled") ||
      element.closest('[aria-disabled="true"]') !== null ||
      element.getAttribute("aria-disabled") === "true";
    const required =
      (element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement) &&
      element.required;
    const checked =
      element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)
        ? element.checked
        : element.getAttribute("aria-checked") === "true"
          ? true
          : element.getAttribute("aria-checked") === "false"
            ? false
            : undefined;
    const selected =
      element.getAttribute("aria-selected") === "true"
        ? true
        : element.getAttribute("aria-selected") === "false"
          ? false
          : undefined;
    const expanded =
      element.getAttribute("aria-expanded") === "true"
        ? true
        : element.getAttribute("aria-expanded") === "false"
          ? false
          : undefined;
    const editable =
      !(element instanceof HTMLInputElement && element.readOnly) &&
      element.getAttribute("aria-readonly") !== "true" &&
      (["textbox", "searchbox", "spinbutton"].includes(role) ||
        (role === "combobox" && (element.tagName === "INPUT" || element.tagName === "TEXTAREA")));
    const operations: Array<"click" | "fill" | "select"> = [];
    if (element.tagName === "SELECT") operations.push("select");
    else if (editable) {
      operations.push("fill");
      operations.push("click");
    } else operations.push("click");
    let value: string | undefined;
    if (omit.has(ref)) {
      omittedValues += 1;
    } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      value = element.value;
    } else if (element instanceof HTMLElement && (element.isContentEditable || role === "combobox")) {
      value = element.innerText.trim();
    }
    const options =
      element instanceof HTMLSelectElement
        ? Array.from(element.options)
            .filter((option) => !option.disabled && option.closest("optgroup[disabled]") === null)
            .map((option) => ({
              value: option.value,
              label: option.label || option.textContent || option.value,
            }))
        : undefined;
    const row: DriveSnapshotElement = {
      ref,
      role,
      label,
      operations,
      frameOrdinal,
      ...(value === undefined ? {} : { value }),
      ...(checked === undefined ? {} : { checked }),
      ...(selected === undefined ? {} : { selected }),
      ...(expanded === undefined ? {} : { expanded }),
      ...(disabled ? { disabled: true } : {}),
      ...(required ? { required: true } : {}),
      ...(inViewport ? {} : { offscreen: true }),
      ...(options === undefined ? {} : { options }),
    };
    if (inViewport) inView.push(row);
    else offscreenControls.push(row);
  }
  const elements = [...inView, ...offscreenControls].slice(0, arg.maxElements);
  const headings: string[] = [];
  for (const heading of Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
    if (!visible(heading)) continue;
    const text = (heading.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length > 0) headings.push(text);
  }
  const words: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let length = 0;
  let node = walker.nextNode();
  while (node !== null && length < 6000) {
    const value = (node.textContent ?? "").trim();
    const parent = node.parentElement;
    if (
      value.length > 0 &&
      parent !== null &&
      parent.closest("script,style,noscript,template") === null &&
      visible(parent)
    ) {
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < innerHeight &&
        rect.right > 0 &&
        rect.left < innerWidth
      ) {
        words.push(value);
        length += value.length;
      }
    }
    node = walker.nextNode();
  }
  const text = words.join("\n").slice(0, 6000);
  const valueParts = elements.map((element) => {
    const bits = [element.ref, element.role, element.label];
    if (element.value !== undefined) bits.push(element.value);
    if (element.checked !== undefined) bits.push(String(element.checked));
    if (element.selected !== undefined) bits.push(String(element.selected));
    return bits.join("\t");
  });
  const fingerprint = [
    location.href,
    document.title,
    headings.join("\n"),
    valueParts.join("\n"),
  ].join("\n");
  return {
    url: location.href,
    title: document.title,
    headings,
    text,
    fingerprint,
    documentEpoch: `${performance.timeOrigin}|${location.href}`,
    elements,
    omittedValues,
    scriptMs: performance.now() - scriptStarted,
  };
}

export async function captureFrameSnapshot(
  target: Page | Frame,
  omitValueRefs: readonly string[],
  frameOrdinal: number,
): Promise<DriveSnapshot | null> {
  const wallStarted = Date.now();
  const raw = await target.evaluate(inPageSnapshot, {
    omitValueRefs: [...omitValueRefs],
    frameOrdinal,
    maxElements: DRIVE_SNAPSHOT_MAX_ELEMENTS,
  });
  const wallMs = Date.now() - wallStarted;
  if (raw === null) return null;
  return { ...raw, wallMs };
}

export function mergeSnapshots(parts: readonly DriveSnapshot[]): DriveSnapshot {
  if (parts.length === 0) {
    return {
      url: "",
      title: "",
      headings: [],
      text: "",
      fingerprint: "",
      documentEpoch: "",
      elements: [],
      omittedValues: 0,
      scriptMs: 0,
      wallMs: 0,
    };
  }
  const main = parts[0]!;
  const elements = parts.flatMap((part) => part.elements);
  const headings = parts.flatMap((part) => part.headings);
  const text = parts.map((part) => part.text).filter((part) => part.length > 0).join("\n");
  const fingerprint = parts.map((part) => part.fingerprint).join("\n---\n");
  return {
    url: main.url,
    title: main.title,
    headings,
    text,
    fingerprint,
    documentEpoch: main.documentEpoch,
    elements,
    omittedValues: parts.reduce((sum, part) => sum + part.omittedValues, 0),
    scriptMs: parts.reduce((sum, part) => sum + part.scriptMs, 0),
    wallMs: parts.reduce((sum, part) => sum + part.wallMs, 0),
  };
}

export async function frameDynamicsSignature(frame: Frame): Promise<string> {
  try {
    return await frame.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input,textarea,select"));
      return [
        location.href,
        document.title,
        inputs.length,
        inputs
          .map((element) => {
            if (element instanceof HTMLInputElement) return `${element.name}:${element.type}`;
            if (element instanceof HTMLSelectElement) return `${element.name}:select:${element.options.length}`;
            return element.tagName;
          })
          .join(","),
      ].join("|");
    });
  } catch {
    return `unreachable:${frame.url()}`;
  }
}
