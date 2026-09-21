// Act-time control identity. A drive `@e:` token stays the wire shape; what
// it names is this record, not a snapshot ordinal. Resolution that does not
// find the same control returns null — the caller must not act on a neighbor.

import type { Frame, Page } from "playwright";
import { frameOriginOf } from "../browser-use-capture.js";
import { evaluateBound } from "../drive-evaluate.js";
import type { InteractiveElement } from "../browser.js";

export type ActControlIdentity = {
  selector: string;
  frameUrl: string;
  frameOrigin: string;
  role: string;
  label: string;
  href?: string;
  picker?: boolean;
  name?: string;
  placeholder?: string;
  inputType?: string;
};

function originOf(url: string): string {
  if (url.length === 0) return "";
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export function canonicalActRole(role: string): string {
  const raw = role.toLowerCase();
  if (raw === "a" || raw === "link") return "link";
  if (raw === "button" || raw === "summary") return "button";
  if (raw === "textarea") return "textbox";
  if (raw === "select") return "combobox";
  if (raw === "input") return "textbox";
  return raw;
}

export function identityFromDriveElement(
  el: {
    selector?: string;
    role: string;
    label: string;
    href?: string;
    frameUrl?: string;
    frameOrigin?: string;
    picker?: boolean;
    name?: string;
    placeholder?: string;
    inputType?: string;
  },
  pageUrl: string,
): ActControlIdentity {
  return {
    selector: el.selector ?? "",
    frameUrl: el.frameUrl ?? pageUrl,
    frameOrigin: el.frameOrigin || originOf(el.frameUrl ?? pageUrl),
    role: canonicalActRole(el.role),
    label: el.label,
    ...(el.href ? { href: el.href } : {}),
    ...(el.picker === true ? { picker: true } : {}),
    ...(el.name ? { name: el.name } : {}),
    ...(el.placeholder ? { placeholder: el.placeholder } : {}),
    ...(el.inputType ? { inputType: el.inputType } : {}),
  };
}

export function rememberDriveIdentities(
  store: { identities?: Map<string, ActControlIdentity> },
  elements: ReadonlyArray<{
    ref: string;
    selector?: string;
    role: string;
    label: string;
    href?: string;
    frameUrl?: string;
    frameOrigin?: string;
    picker?: boolean;
    name?: string;
    placeholder?: string;
    inputType?: string;
  }>,
  pageUrl: string,
): Map<string, ActControlIdentity> {
  const identities = new Map<string, ActControlIdentity>();
  for (const element of elements) {
    identities.set(element.ref, identityFromDriveElement(element, pageUrl));
  }
  store.identities = identities;
  return identities;
}

export function interactiveFromIdentity(
  identity: ActControlIdentity,
  extras?: { framePath?: string; frameUrl?: string; frameOrigin?: string },
): InteractiveElement {
  const role = canonicalActRole(identity.role);
  const tag =
    role === "link"
      ? "a"
      : role === "button"
        ? "button"
        : role === "combobox"
          ? "select"
          : role === "textbox"
            ? "input"
            : role || "div";
  const frameUrl = extras?.frameUrl ?? identity.frameUrl;
  const frameOrigin = extras?.frameOrigin ?? identity.frameOrigin;
  return {
    index: 0,
    tag,
    type: identity.picker === true ? "date" : (identity.inputType ?? null),
    id: identity.selector.startsWith("#") ? identity.selector.slice(1) : null,
    name: identity.name ?? null,
    placeholder: identity.placeholder ?? null,
    ariaLabel: identity.label,
    role,
    labelText: identity.label,
    visibleText: identity.label,
    selector: identity.selector,
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    href: identity.href ?? null,
    frameUrl: frameUrl.length > 0 ? frameUrl : null,
    frameOrigin: frameOrigin.length > 0 ? frameOrigin : null,
    ...(extras?.framePath !== undefined ? { framePath: extras.framePath } : {}),
  };
}

function framePathOf(frame: Page | Frame): string | undefined {
  if (!("parentFrame" in frame)) return undefined;
  const indexes: number[] = [];
  let current: Frame | null = frame;
  while (current !== null) {
    const parent = current.parentFrame();
    if (parent === null) break;
    const index = parent.childFrames().indexOf(current);
    if (index < 0) return undefined;
    indexes.unshift(index);
    current = parent;
  }
  return indexes.length === 0 ? undefined : indexes.join("/");
}

/** The frame ordinal the drive minted this ref in; snapshots number `page.frames()`. */
export function driveRefFrameOrdinal(ref: string): number {
  const match = /^@e:f(\d+)d\d+$/.exec(ref);
  return match === null ? 0 : Number(match[1]);
}

export function driveRefScope(page: Page, ref: string): Frame {
  return page.frames()[driveRefFrameOrdinal(ref)] ?? page.mainFrame();
}

// One rule: the ref's registered node is still connected AND the identity's
// selector resolves to exactly that node. A second spelling of "close enough"
// is how an act lands on the neighbor this record exists to refuse.
function inPageSameControl(arg: { ref: string; selector: string }): boolean {
  type DriveCache = { nodes: Map<string, Element> };
  const registry = (window as Window & { __tsDriveRegistry?: DriveCache }).__tsDriveRegistry;
  const node = registry?.nodes.get(arg.ref);
  if (node === undefined || !node.isConnected) return false;
  try {
    const found = document.querySelectorAll(arg.selector);
    return found.length === 1 && found[0] === node;
  } catch {
    return false;
  }
}

/** Live element for a drive ref, or null when it is no longer the same control. */
export async function resolveLiveControlIdentity(
  page: Page,
  ref: string,
  identity: ActControlIdentity,
): Promise<InteractiveElement | null> {
  if (identity.selector.length === 0) return null;
  const scope = driveRefScope(page, ref);
  const same = await evaluateBound(scope, inPageSameControl, {
    ref,
    selector: identity.selector,
  }).catch(() => false);
  if (!same) return null;
  const framePath = framePathOf(scope);
  return interactiveFromIdentity(identity, {
    ...(framePath === undefined ? {} : { framePath }),
    frameUrl: scope.url(),
    frameOrigin: frameOriginOf(scope),
  });
}

/** Index of the canonical element that IS the node the drive ref registered. */
export function canonicalIndexForDriveRef(arg: {
  ref: string;
  candidates: Array<{ index: number; selector: string }>;
}): number {
  type DriveCache = { nodes: Map<string, Element> };
  const registry = (window as Window & { __tsDriveRegistry?: DriveCache }).__tsDriveRegistry;
  const node = registry?.nodes.get(arg.ref);
  if (node === undefined || !node.isConnected) return -1;
  for (const candidate of arg.candidates) {
    try {
      if (document.querySelector(candidate.selector) === node) return candidate.index;
    } catch {
      continue;
    }
  }
  return -1;
}
