// Drive-loop snapshot. Modeled on browser-use/jev-ultrafast snapshot.js (MIT).
// One in-page evaluate: visible-text labels, all headings, a fingerprint, and a
// node registry keyed by our refs. Used only inside operate_drive.

import type { Frame, Page } from "playwright";
import { frameOriginOf } from "./browser-use-capture.js";
import { DriveEvaluateTimeout, evaluateBound } from "./drive-evaluate.js";
import type { Observation } from "./provision-session.js";

type SnapshotRow = [string, string, string?];

export const DRIVE_SNAPSHOT_MAX_ELEMENTS = 250;
export const DRIVE_SNAPSHOT_BUDGET_MS = 2500;
export const DRIVE_SNAPSHOT_MAX_WALK_NODES = 2000;
export const DRIVE_SNAPSHOT_MAX_NAME_VISITS = 400;

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
  picker?: boolean;
  /** The control's own `maxlength`, when it declares one. */
  width?: number;
  placeholder?: string;
  /** The control's HTML `name`, when it has one. */
  name?: string;
  /** The `aria-label` ATTRIBUTE, not the resolved accessible name. */
  ariaLabel?: string;
  /** The label is the full accessible name, so an act-time read can match it. */
  labelComparable?: boolean;
  /** The input `type` (`email`, `text`, …), when the node is an input. */
  inputType?: string;
  /** Live CSS/Playwright selector for the node, used to re-resolve identity. */
  selector?: string;
  frameUrl?: string;
  frameOrigin?: string;
  /** Resolved href for a link, used to prefer in-app paths over docs. */
  href?: string;
  pattern?: string;
  inputMode?: string;
  invalid?: boolean;
  /** HTML form owner identity, stable for one snapshot walk. */
  formId?: number;
  /** Covering control ref, or a region kind when the cover is not a listed control. */
  occludedBy?: string;
  operations: Array<"click" | "fill" | "select">;
  options?: DriveSnapshotOption[];
  frameOrdinal: number;
}

export interface DriveSnapshot {
  url: string;
  title: string;
  headings: string[];
  text: string;
  /** Live-region / aria-invalid descriptions, even when they just became visible. */
  notices?: string[];
  fingerprint: string;
  documentEpoch: string;
  elements: DriveSnapshotElement[];
  omittedValues: number;
  scriptMs: number;
  wallMs: number;
  timedOut?: boolean;
}

interface DriveSnapshotArg {
  omitValueRefs: string[];
  frameOrdinal: number;
  maxElements: number;
  budgetMs: number;
  maxWalkNodes: number;
  maxNameVisits: number;
  keepOffscreenButtons: boolean;
}

type DriveInPageSnapshot = {
  url: string;
  title: string;
  headings: string[];
  text: string;
  notices: string[];
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
  { test: /where\s+from|\borigin\b|leaving\s+from/, field: "origin" },
  { test: /where\s+to|\bdestination\b|going\s+to/, field: "destination" },
  {
    test: /\bdepart(?:ure)?(?:\s*date)?\b|\barrival(?:\s*date)?\b|\bexpir(?:y|ation|es)?\b|\bcalendar\b|\bdate\b/,
    field: "date",
  },
  { test: /password/, field: "password" },
  { test: /phone|tel|mobile/, field: "phone" },
  { test: /\baddress[\s-]*(?:line[\s-]*)?2\b|\b(?:apt|apartment|unit|suite)\b/, field: "address2" },
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

const EMAIL_SHAPE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;

export function looksLikeEmailAddress(value: string): boolean {
  return EMAIL_SHAPE.test(value);
}

/** Fact key from the control's label or name. Type/placeholder email wins; a domain in a placeholder never names the field. */
export function inferFieldFromControl(input: {
  label: string;
  role: string;
  name?: string;
  placeholder?: string;
  inputType?: string;
}): string | undefined {
  const type = (input.inputType ?? "").toLowerCase();
  if (type === "email") return "email";
  if (looksLikeEmailAddress(input.placeholder ?? "") || looksLikeEmailAddress(input.label)) {
    return "email";
  }
  const fromName = inferFieldFromLabel(input.name ?? "", input.role);
  if (fromName !== undefined) return fromName;
  if ((input.placeholder ?? "").length > 0 && input.label === input.placeholder) {
    return undefined;
  }
  return inferFieldFromLabel(input.label, input.role);
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
    const field = inferFieldFromControl({
      label: element.label,
      role: element.role,
      ...(element.name === undefined ? {} : { name: element.name }),
      ...(element.placeholder === undefined ? {} : { placeholder: element.placeholder }),
      ...(element.inputType === undefined ? {} : { inputType: element.inputType }),
    });
    if (field !== undefined) facts.push(`f=${field}`);
    const states: string[] = [];
    if (element.required === true) states.push("r");
    if (element.disabled === true) states.push("d");
    if (element.invalid === true) states.push("i");
    if (element.checked === true) states.push("c");
    if (element.checked === false && (element.role === "checkbox" || element.role === "radio")) {
      states.push("u");
    }
    if (states.length > 0) facts.push(`s=${states.join("")}`);
    if (element.offscreen === true) facts.push("v=offscreen");
    if (element.picker === true) facts.push("a=picker");
    if (element.value !== undefined && element.value.length > 0) {
      facts.push(`n=${element.value.replace(/\|/g, " ").slice(0, 80)}`);
    }
    if (element.width !== undefined) facts.push(`w=${element.width}`);
    if (element.placeholder !== undefined && element.placeholder.length > 0) {
      facts.push(`ph=${element.placeholder.replace(/\|/g, " ").slice(0, 40)}`);
    }
    if (element.href !== undefined && element.href.length > 0) {
      facts.push(`u=${element.href.replace(/\|/g, " ").slice(0, 120)}`);
    }
    if (element.pattern !== undefined && element.pattern.length > 0) {
      facts.push(`pt=${element.pattern.replace(/\|/g, " ").slice(0, 40)}`);
    }
    if (element.inputMode !== undefined && element.inputMode.length > 0) {
      facts.push(`im=${element.inputMode.replace(/\|/g, " ").slice(0, 20)}`);
    }
    const choice = optionOrdinal.get(element.ref);
    if (choice !== undefined) facts.push(`q=${choice.index}/${choice.total}`);
    if (element.formId !== undefined) facts.push(`fm=${element.formId}`);
    if (element.occludedBy !== undefined && element.occludedBy.length > 0) {
      facts.push(`oc=${element.occludedBy.replace(/\|/g, " ").slice(0, 40)}`);
    }
    const roleLetter =
      element.role === "button"
        ? "b"
        : element.role === "link" || element.role === "option"
          ? "l"
          : element.role === "textbox" ||
              element.role === "searchbox" ||
              element.role === "spinbutton"
            ? "t"
            : element.role === "combobox" && element.operations.includes("select")
              ? "s"
              : element.role === "combobox" && element.operations.includes("fill")
                ? "t"
                : element.role === "checkbox"
                  ? "c"
                  : element.role === "radio"
                    ? "r"
                    : element.role === "tab"
                      ? "tb"
                      : element.role === "menuitem"
                        ? "m"
                        : element.role;
    rows.push(
      facts.length === 0 ? [element.ref, roleLetter] : [element.ref, roleLetter, facts.join("|")],
    );
  }
  return rows;
}

export function snapshotSelectOptions(snapshot: DriveSnapshot): Map<string, string[]> {
  const options = new Map<string, string[]>();
  const add = (key: string, texts: readonly string[]) => {
    if (texts.length === 0) return;
    const existing = options.get(key) ?? [];
    for (const text of texts) {
      if (text.length > 0 && !existing.includes(text)) existing.push(text);
    }
    if (existing.length > 0) options.set(key, existing);
  };
  for (const element of snapshot.elements) {
    if (element.options === undefined || element.options.length === 0) continue;
    const texts = element.options.map((option) => option.label).filter((text) => text.length > 0);
    add(element.ref, texts);
    const label = element.label.trim().toLowerCase();
    if (label.length > 0) add(label, texts);
  }
  let owner: DriveSnapshotElement | undefined;
  for (const element of snapshot.elements) {
    if (element.role === "combobox" && !element.operations.includes("fill")) {
      owner = element;
    }
    if (element.role === "option" && owner !== undefined && element.label.trim().length > 0) {
      add(owner.ref, [element.label.trim()]);
      const label = owner.label.trim().toLowerCase();
      if (label.length > 0) add(label, [element.label.trim()]);
    }
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
      ...(snapshot.notices !== undefined && snapshot.notices.length > 0
        ? { blockers: snapshot.notices.map((text) => ({ kind: "validation" as const, text })) }
        : {}),
    },
  };
}

function inPageSnapshot(arg: DriveSnapshotArg): DriveInPageSnapshot | null {
  const scriptStarted = performance.now();
  const deadline = scriptStarted + arg.budgetMs;
  const expired = (): boolean => performance.now() >= deadline;
  if (document.body === null) return null;
  type ControlDescription = { role: string; label: string; href: string };
  type DriveCache = {
    ids: WeakMap<Element, number>;
    nodes: Map<string, Element>;
    next: number;
    describe?: (element: Element) => ControlDescription | null;
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
    // Password inputs stay capturable fill targets (the drive generates the
    // password as a fact and must be able to fill it); only their VALUES are
    // never emitted. file/hidden inputs are not drive targets at all.
    return !["file", "hidden"].includes(element.type);
  };
  const visible = (element: Element): boolean => {
    if (element.closest('[aria-hidden="true"],[inert]') !== null) return false;
    if (typeof element.checkVisibility === "function") {
      return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };
  let nameVisits = 0;
  let nameDeadline = deadline;
  const name = (element: Element | null, seen = new Set<Element>()): string => {
    if (
      element === null ||
      seen.has(element) ||
      nameVisits >= arg.maxNameVisits ||
      performance.now() >= nameDeadline
    ) {
      return "";
    }
    nameVisits += 1;
    seen.add(element);
    const labelledBy = (element.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => name(document.getElementById(id), seen))
      .filter((part) => part.length > 0)
      .join(" ");
    if (labelledBy.length > 0) return labelledBy;
    const aria = element.getAttribute("aria-label");
    if (aria !== null && aria.trim().length > 0) return aria.trim();
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLButtonElement
    ) {
      const labels = element.labels === null ? [] : Array.from(element.labels);
      const fromLabels = labels
        .map((label) => name(label, seen))
        .filter((part) => part.length > 0)
        .join(" ");
      if (fromLabels.length > 0) return fromLabels;
    }
    if (
      element instanceof HTMLInputElement &&
      ["button", "submit", "reset"].includes(element.type) &&
      element.value.length > 0
    ) {
      return element.value;
    }
    const alt = element.getAttribute("alt");
    if (alt !== null && alt.trim().length > 0) return alt.trim();
    if (element.tagName !== "INPUT") {
      const child = Array.from(element.childNodes)
        .map((node) => {
          if (node.nodeType === 3) return (node.textContent ?? "").trim();
          if (
            node.nodeType === 1 &&
            node instanceof Element &&
            node.getAttribute("aria-hidden") !== "true"
          ) {
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
    if (
      element.tagName === "TEXTAREA" ||
      (element instanceof HTMLElement && element.isContentEditable)
    ) {
      return "textbox";
    }
    if (element instanceof HTMLInputElement) {
      if (["checkbox", "radio"].includes(element.type)) return element.type;
      if (["button", "submit", "reset", "image"].includes(element.type)) return "button";
      if (element.type === "search") return "searchbox";
      if (element.type === "number") return "spinbutton";
      if (element.type === "password") return "textbox";
      if (["text", "email", "url", "tel"].includes(element.type)) return "textbox";
    }
    return null;
  };
  // The label an act-time check can reproduce: the accessible name under a
  // budget it can re-arm. `truncated` says the walk ran out mid-element, so the
  // recorded spelling is a prefix nothing can derive again.
  const accessibleName = (element: Element, role: string): { label: string; truncated: boolean } => {
    const derived = name(element);
    return {
      label: derived || role,
      truncated: nameVisits >= arg.maxNameVisits || performance.now() >= nameDeadline,
    };
  };
  // Act-time identity reads the control back through the SAME derivation, with
  // the name budget re-armed, so a node React mutated in place cannot pass as
  // the control the decision named.
  cache.describe = (element: Element): { role: string; label: string; href: string } | null => {
    const role = roleOf(element);
    if (role === null) return null;
    nameVisits = 0;
    nameDeadline = performance.now() + 250;
    return {
      role,
      label: name(element) || role,
      href: element instanceof HTMLAnchorElement && element.href.length > 0 ? element.href : "",
    };
  };
  const selectorFor = (node: Element): string => {
    const namesOnlyThisNode = (candidate: string): boolean => {
      try {
        const found = document.querySelectorAll(candidate);
        return found.length === 1 && found[0] === node;
      } catch {
        return false;
      }
    };
    const quoted = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const tag = node.tagName.toLowerCase();
    for (const attr of ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"]) {
      const value = node.getAttribute(attr);
      if (value === null || value.length === 0) continue;
      const candidate = `[${attr}="${quoted(value)}"]`;
      if (namesOnlyThisNode(candidate)) return candidate;
    }
    const id = node.getAttribute("id");
    if (id !== null && /^[A-Za-z][\w-]*$/.test(id) && namesOnlyThisNode(`#${id}`)) return `#${id}`;
    const name = node.getAttribute("name");
    if (name !== null && name.length > 0) {
      const candidate = `${tag}[name="${quoted(name)}"]`;
      if (namesOnlyThisNode(candidate)) return candidate;
    }
    const parts: string[] = [];
    let walk: Element | null = node;
    while (walk !== null) {
      const cur: Element = walk;
      const t = cur.tagName.toLowerCase();
      const parent: Element | null = cur.parentElement;
      if (parent === null) {
        parts.unshift(t);
        break;
      }
      const sibs = Array.from(parent.children).filter(
        (child): child is Element => child.tagName === cur.tagName,
      );
      parts.unshift(sibs.length > 1 ? `${t}:nth-of-type(${sibs.indexOf(cur) + 1})` : t);
      walk = parent;
    }
    return parts.join(" > ");
  };
  const formIds = new WeakMap<Element, number>();
  let nextForm = 1;
  const formIdOf = (element: Element): number | undefined => {
    const owner =
      element instanceof HTMLInputElement ||
      element instanceof HTMLButtonElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
        ? element.form
        : element.closest("form");
    if (owner === null) return undefined;
    let id = formIds.get(owner);
    if (id === undefined) {
      id = nextForm;
      nextForm += 1;
      formIds.set(owner, id);
    }
    return id;
  };
  const inView: DriveSnapshotElement[] = [];
  const offscreenControls: DriveSnapshotElement[] = [];
  let omittedValues = 0;
  for (const element of Array.from(document.querySelectorAll(selector))) {
    if (expired()) break;
    if (!safe(element) || !visible(element)) continue;
    const role = roleOf(element);
    if (role === null) continue;
    if (role === "gridcell" && element.querySelector("button,[role='button']") !== null) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const inViewport =
      rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
    const buttonLike = role === "button" || element.tagName === "BUTTON";
    const keepOffscreen =
      role === "textbox" ||
      role === "searchbox" ||
      role === "spinbutton" ||
      role === "checkbox" ||
      role === "radio" ||
      role === "combobox" ||
      element.tagName === "SELECT" ||
      (buttonLike && arg.keepOffscreenButtons);
    const pinned =
      element.closest(
        "header,nav,footer,[role='banner'],[role='navigation'],[role='contentinfo']",
      ) !== null;
    if (!inViewport && !keepOffscreen && !pinned) continue;
    const ref = identity(element);
    // Offscreen and unkept: the cheap aria-label spelling, which depends on the
    // viewport at this instant and so is not comparable later.
    const offscreenLabel = !inViewport && !keepOffscreen;
    const named = offscreenLabel ? null : accessibleName(element, role);
    const label = named === null ? element.getAttribute("aria-label")?.trim() || role : named.label;
    const labelComparable = named !== null && !named.truncated;
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
    const picker =
      (["textbox", "searchbox", "combobox", "spinbutton"].includes(role) ||
        element.tagName === "INPUT") &&
      (role === "combobox" ||
        element.getAttribute("aria-haspopup") !== null ||
        element.getAttribute("aria-autocomplete") !== null ||
        element.getAttribute("aria-readonly") === "true" ||
        (element instanceof HTMLInputElement &&
          (element.readOnly || ["date", "datetime-local", "month"].includes(element.type))));
    const operations: Array<"click" | "fill" | "select"> = [];
    if (element.tagName === "SELECT") operations.push("select");
    else if (editable) {
      operations.push("fill");
      operations.push("click");
    } else operations.push("click");
    let value: string | undefined;
    if (omit.has(ref)) {
      omittedValues += 1;
    } else if (element instanceof HTMLInputElement && element.type === "password") {
      // A password field is reported so the drive can fill it, but its value
      // is never emitted — not to rows, not to the snapshot fingerprint.
      omittedValues += 1;
    } else if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      value = element.value;
    } else if (
      element instanceof HTMLElement &&
      (element.isContentEditable || role === "combobox")
    ) {
      value = (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    }
    const width =
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
      element.maxLength > 0
        ? element.maxLength
        : undefined;
    const href =
      element instanceof HTMLAnchorElement && element.href.length > 0 ? element.href : "";
    const placeholder = element.getAttribute("placeholder")?.trim() ?? "";
    const ariaLabel = element.getAttribute("aria-label")?.trim() ?? "";
    const inputName =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? element.name.trim()
        : (element.getAttribute("name") ?? "").trim();
    const inputType = element instanceof HTMLInputElement ? element.type : "";
    const pattern = element instanceof HTMLInputElement ? element.pattern.trim() : "";
    const inputMode = element.getAttribute("inputmode")?.trim() ?? "";
    const invalid =
      element.getAttribute("aria-invalid") === "true" ||
      ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
        element.value.length > 0 &&
        !element.validity.valid);
    const formId = formIdOf(element);
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
      selector: selectorFor(element),
      ...(value === undefined ? {} : { value }),
      ...(checked === undefined ? {} : { checked }),
      ...(selected === undefined ? {} : { selected }),
      ...(expanded === undefined ? {} : { expanded }),
      ...(disabled ? { disabled: true } : {}),
      ...(required ? { required: true } : {}),
      ...(inViewport ? {} : { offscreen: true }),
      ...(picker ? { picker: true } : {}),
      ...(width === undefined ? {} : { width }),
      ...(placeholder.length > 0 ? { placeholder } : {}),
      ...(ariaLabel.length > 0 ? { ariaLabel } : {}),
      ...(labelComparable ? { labelComparable: true } : {}),
      ...(href.length > 0 ? { href } : {}),
      ...(inputName.length > 0 ? { name: inputName } : {}),
      ...(inputType.length > 0 ? { inputType } : {}),
      ...(pattern.length > 0 ? { pattern } : {}),
      ...(inputMode.length > 0 ? { inputMode } : {}),
      ...(invalid ? { invalid: true } : {}),
      ...(formId === undefined ? {} : { formId }),
      ...(options === undefined ? {} : { options }),
    };
    if (inViewport) inView.push(row);
    else offscreenControls.push(row);
  }
  // Offer-time occlusion: the act guard already refuses a covered target.
  // Recording the cover here lets ranking prefer it before a wasted click.
  const refOf = new WeakMap<Element, string>();
  for (const [ref, node] of cache.nodes) refOf.set(node, ref);
  const occluderOf = (element: Element, selfRef: string): string | undefined => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    const x = Math.min(innerWidth - 1, Math.max(0, rect.x + rect.width / 2));
    const y = Math.min(innerHeight - 1, Math.max(0, rect.y + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    if (hit === null || hit === element || element.contains(hit) || hit.contains(element)) {
      return undefined;
    }
    let cur: Element | null = hit;
    while (cur !== null) {
      const cover = refOf.get(cur);
      if (cover !== undefined && cover !== selfRef) return cover;
      cur = cur.parentElement;
    }
    const named = hit.closest(
      "dialog,[role='dialog'],[role='alertdialog'],[role='banner'],[role='complementary'],aside,header",
    );
    if (named !== null) {
      const role = (named.getAttribute("role") ?? named.tagName).toLowerCase();
      if (role === "dialog" || role === "alertdialog" || named.tagName === "DIALOG") return "dialog";
      if (role === "banner" || named.tagName === "HEADER") return "banner";
      if (role === "complementary" || named.tagName === "ASIDE") return "aside";
    }
    return "overlay";
  };
  for (const row of inView) {
    const node = cache.nodes.get(row.ref);
    if (node === undefined) continue;
    const occludedBy = occluderOf(node, row.ref);
    if (occludedBy !== undefined) row.occludedBy = occludedBy;
  }
  const fieldsFirst = (list: DriveSnapshotElement[]): DriveSnapshotElement[] => {
    const fields = list.filter(
      (row) => row.operations.includes("fill") || row.operations.includes("select"),
    );
    const rest = list.filter(
      (row) => !row.operations.includes("fill") && !row.operations.includes("select"),
    );
    return [...fields, ...rest];
  };
  const elements = [...fieldsFirst(inView), ...fieldsFirst(offscreenControls)].slice(
    0,
    arg.maxElements,
  );
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
  let walkNodes = 0;
  let node = walker.nextNode();
  while (node !== null && length < 6000 && walkNodes < arg.maxWalkNodes && !expired()) {
    walkNodes += 1;
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
  const notices: string[] = [];
  const seenNotice = new Set<string>();
  const addNotice = (raw: string): void => {
    const value = raw.replace(/\s+/g, " ").trim();
    if (value.length === 0) return;
    const key = value.toLowerCase();
    if (seenNotice.has(key)) return;
    seenNotice.add(key);
    notices.push(value);
  };
  for (const el of Array.from(
    document.querySelectorAll(
      '[role="alert"],[role="status"],[aria-live]:not([aria-live="off"])',
    ),
  )) {
    if (!visible(el)) continue;
    addNotice(el.textContent ?? "");
  }
  const describedIds = (el: Element): string[] =>
    `${el.getAttribute("aria-describedby") ?? ""} ${el.getAttribute("aria-errormessage") ?? ""}`
      .split(/\s+/)
      .filter((id) => id.length > 0);
  for (const el of Array.from(document.querySelectorAll("[aria-invalid='true']"))) {
    for (const id of describedIds(el)) {
      const desc = document.getElementById(id);
      if (desc === null) continue;
      addNotice(desc.textContent ?? "");
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      addNotice(el.validationMessage);
    }
  }
  const collectJsonErrors = (value: unknown, depth: number): void => {
    if (depth > 6 || notices.length >= 12) return;
    if (typeof value === "string") {
      if (value.length > 4) addNotice(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) collectJsonErrors(entry, depth + 1);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (/error/i.test(key)) collectJsonErrors(entry, depth + 1);
    }
  };
  for (const script of Array.from(document.querySelectorAll("script"))) {
    const raw = (script.textContent ?? "").trim();
    if (raw.length < 8 || (raw[0] !== "{" && raw[0] !== "[")) continue;
    try {
      collectJsonErrors(JSON.parse(raw) as unknown, 0);
    } catch {
      // Not JSON — ordinary application scripts stay ignored.
    }
  }
  const text = [notices.join("\n"), words.join("\n")]
    .filter((part) => part.length > 0)
    .join("\n")
    .slice(0, 6000);
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
    notices,
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
  keepOffscreenButtons = false,
): Promise<DriveSnapshot | null> {
  const wallStarted = Date.now();
  try {
    const raw = await evaluateBound(target, inPageSnapshot, {
      omitValueRefs: [...omitValueRefs],
      frameOrdinal,
      maxElements: DRIVE_SNAPSHOT_MAX_ELEMENTS,
      budgetMs: DRIVE_SNAPSHOT_BUDGET_MS,
      maxWalkNodes: DRIVE_SNAPSHOT_MAX_WALK_NODES,
      maxNameVisits: DRIVE_SNAPSHOT_MAX_NAME_VISITS,
      keepOffscreenButtons,
    });
    const wallMs = Date.now() - wallStarted;
    if (raw === null) return null;
    const frameUrl = target.url();
    const frameOrigin = frameOriginOf(target);
    return {
      ...raw,
      wallMs,
      elements: raw.elements.map((element) => ({
        ...element,
        frameUrl,
        frameOrigin,
      })),
    };
  } catch (error) {
    if (!(error instanceof DriveEvaluateTimeout)) return null;
    return {
      url: "",
      title: "",
      headings: [],
      text: "",
      notices: [],
      fingerprint: "",
      documentEpoch: "",
      elements: [],
      omittedValues: 0,
      scriptMs: 0,
      wallMs: Date.now() - wallStarted,
      timedOut: true,
    };
  }
}

export function mergeSnapshots(parts: readonly DriveSnapshot[]): DriveSnapshot {
  if (parts.length === 0) {
    return {
      url: "",
      title: "",
      headings: [],
      text: "",
      notices: [],
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
  const text = parts
    .map((part) => part.text)
    .filter((part) => part.length > 0)
    .join("\n");
  const notices: string[] = [];
  const seenNotice = new Set<string>();
  for (const part of parts) {
    for (const notice of part.notices ?? []) {
      const key = notice.toLowerCase();
      if (notice.length === 0 || seenNotice.has(key)) continue;
      seenNotice.add(key);
      notices.push(notice);
    }
  }
  const fingerprint = parts.map((part) => part.fingerprint).join("\n---\n");
  return {
    url: main.url,
    title: main.title,
    headings,
    text,
    ...(notices.length > 0 ? { notices } : {}),
    fingerprint,
    documentEpoch: main.documentEpoch,
    elements,
    omittedValues: parts.reduce((sum, part) => sum + part.omittedValues, 0),
    scriptMs: parts.reduce((sum, part) => sum + part.scriptMs, 0),
    wallMs: parts.reduce((sum, part) => sum + part.wallMs, 0),
    ...(parts.some((part) => part.timedOut === true) ? { timedOut: true } : {}),
  };
}

export async function frameDynamicsSignature(frame: Frame): Promise<string> {
  try {
    return await evaluateBound(frame, () => {
      const inputs = Array.from(document.querySelectorAll("input,textarea,select"));
      return [
        location.href,
        document.title,
        inputs.length,
        inputs
          .map((element) => {
            const disabled = element.matches(":disabled") ? "!" : "";
            if (element instanceof HTMLInputElement) {
              // Password values are omitted exactly as in the snapshot rows;
              // everything else participates so a value change (typed text,
              // autofill) invalidates the frame cache even when the DOM
              // structure is unchanged.
              const value = element.type === "password" ? "" : element.value;
              return `${element.name}:${element.type}${disabled}=${value}`;
            }
            if (element instanceof HTMLSelectElement) {
              const options = Array.from(element.options)
                .map((option) => `${option.value}~${option.label}`)
                .join(",");
              return `${element.name}:select${disabled}=${element.value}[${options}]`;
            }
            return `${element.tagName}${disabled}${
              element instanceof HTMLInputElement ||
              element instanceof HTMLTextAreaElement ||
              element instanceof HTMLSelectElement
                ? `=${element.value}`
                : ""
            }`;
          })
          .join(","),
      ].join("|");
    });
  } catch {
    return `unreachable:${frame.url()}`;
  }
}
