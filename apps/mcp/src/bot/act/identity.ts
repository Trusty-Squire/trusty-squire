// Act-time control identity. A drive `@e:` token stays the wire shape; what
// it names is this record, not a snapshot ordinal. Resolution that does not
// find the same control returns null — the caller must not act on a neighbor.

import type { Frame, Page } from "playwright";
import { frameOriginOf } from "../browser-use-capture.js";
import { DriveEvaluateTimeout, evaluateBound } from "../drive-evaluate.js";
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
  ariaLabel?: string;
  labelComparable?: boolean;
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
    ariaLabel?: string;
    labelComparable?: boolean;
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
    ...(el.ariaLabel ? { ariaLabel: el.ariaLabel } : {}),
    ...(el.labelComparable === true ? { labelComparable: true } : {}),
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
    ariaLabel?: string;
    labelComparable?: boolean;
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
  extras?: { framePath?: string },
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
  const frameUrl = identity.frameUrl;
  const frameOrigin = identity.frameOrigin;
  return {
    index: 0,
    tag,
    type: identity.inputType ?? null,
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

// One rule: the ref's registered node is still connected, the identity's
// selector resolves to exactly that node, and the node still reads back as the
// role, label and destination the decision named. Node identity alone misses an
// in-place re-render, where the same node keeps its selector and becomes a
// different control.
function inPageSameControl(arg: {
  ref: string;
  selector: string;
  role: string;
  label: string;
  href: string;
  compareLabel: boolean;
}): boolean {
  type ControlDescription = { role: string; label: string; href: string };
  type DriveCache = {
    nodes: Map<string, Element>;
    describe?: (element: Element) => ControlDescription | null;
  };
  const registry = (window as Window & { __tsDriveRegistry?: DriveCache }).__tsDriveRegistry;
  const node = registry?.nodes.get(arg.ref);
  if (node === undefined || !node.isConnected) return false;
  try {
    const found = document.querySelectorAll(arg.selector);
    if (found.length !== 1 || found[0] !== node) return false;
  } catch {
    return false;
  }
  const describe = registry?.describe;
  if (typeof describe !== "function") return false;
  const live = describe(node);
  if (live === null) return false;
  if (live.role.toLowerCase() !== arg.role) return false;
  if (live.href !== arg.href) return false;
  // Only a label the snapshot derived the same way can be matched; role and
  // destination carry the check for the rest.
  if (!arg.compareLabel) return true;
  const normalize = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
  return normalize(live.label) === normalize(arg.label);
}

/** Frames the identity names. Origin is the part that survives a pushState;
 *  a positional `page.frames()` ordinal is exactly what this record replaces. */
function identityFrameCandidates(page: Page, identity: ActControlIdentity): Frame[] {
  const sameOrigin = page
    .frames()
    .filter(
      (frame) => identity.frameOrigin.length === 0 || frameOriginOf(frame) === identity.frameOrigin,
    );
  const exact = sameOrigin.filter((frame) => frame.url() === identity.frameUrl);
  return exact.length > 0 ? exact : sameOrigin;
}

/** The frame the identity names that still holds the ref's registered node. */
export async function resolveIdentityScope(
  page: Page,
  ref: string,
  identity: ActControlIdentity,
): Promise<Frame | null> {
  if (identity.selector.length === 0) return null;
  for (const scope of identityFrameCandidates(page, identity)) {
    const same = await evaluateBound(scope, inPageSameControl, {
      ref,
      selector: identity.selector,
      role: identity.role,
      label: identity.label,
      href: identity.href ?? "",
      compareLabel: identity.labelComparable === true,
    }).catch((error: unknown) => {
      // A stalled in-page read is the operator's abort, not a verdict that this
      // is a different control: swallowing it would let the caller carry on.
      if (error instanceof DriveEvaluateTimeout) throw error;
      return false;
    });
    if (same) return scope;
  }
  return null;
}

/** Live element for a drive ref, or null when it is no longer the same control. */
export async function resolveLiveControlIdentity(
  page: Page,
  ref: string,
  identity: ActControlIdentity,
): Promise<InteractiveElement | null> {
  const scope = await resolveIdentityScope(page, ref, identity);
  if (scope === null) return null;
  const framePath = framePathOf(scope);
  return interactiveFromIdentity(identity, framePath === undefined ? undefined : { framePath });
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
