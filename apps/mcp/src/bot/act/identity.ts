// Act-time control identity. A drive `@e:` token stays the wire shape; what
// it names is this record, not a snapshot ordinal. Resolution that does not
// find the same control returns null — the caller must not act on a neighbor.

import type { Frame, Page } from "playwright";
import type { InteractiveElement } from "../browser.js";

export type ActControlIdentity = {
  selector: string;
  frameUrl: string;
  frameOrigin: string;
  role: string;
  label: string;
  href?: string;
  picker?: boolean;
};

function originOf(url: string): string {
  if (url.length === 0) return "";
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export function normalizeIdentityLabel(label: string): string {
  return label.replace(/\s+/g, " ").trim().toLowerCase();
}

export function normalizeIdentityHref(href: string | undefined, pageUrl: string): string {
  if (href === undefined || href.length === 0 || href.startsWith("#")) return "";
  try {
    const target = new URL(href, pageUrl.length > 0 ? pageUrl : "https://identity.invalid");
    return `${target.origin}${target.pathname}`;
  } catch {
    return href.split("#")[0] ?? "";
  }
}

export function canonicalActRole(role: string, tag?: string): string {
  const raw = (role.length > 0 ? role : (tag ?? "")).toLowerCase();
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

export function sessionActIdentities(session: {
  actIdentities?: Map<string, ActControlIdentity>;
  drive?: { identities?: Map<string, ActControlIdentity> } | null;
}): Map<string, ActControlIdentity> | undefined {
  return session.drive?.identities ?? session.actIdentities;
}

export function identityFromInteractiveElement(
  el: InteractiveElement,
  pageUrl = "",
): ActControlIdentity {
  const label =
    el.visibleText ?? el.labelText ?? el.ariaLabel ?? el.name ?? el.placeholder ?? el.tag;
  const frameUrl = el.frameUrl || pageUrl;
  return {
    selector: el.selector,
    frameUrl,
    frameOrigin: el.frameOrigin || originOf(frameUrl),
    role: canonicalActRole(el.role ?? "", el.tag),
    label,
    ...(el.href ? { href: el.href } : {}),
  };
}

export function identityKey(identity: ActControlIdentity, pageUrl = ""): string {
  return [
    identity.frameOrigin,
    identity.frameUrl,
    canonicalActRole(identity.role),
    normalizeIdentityLabel(identity.label),
    normalizeIdentityHref(identity.href, pageUrl || identity.frameUrl),
  ].join("\t");
}

function framesAlign(el: InteractiveElement, identity: ActControlIdentity, pageUrl: string): boolean {
  const live = identityFromInteractiveElement(el, pageUrl);
  const liveMain = (el.frameUrl == null || el.frameUrl === "") && (el.frameOrigin == null || el.frameOrigin === "");
  if (liveMain) {
    return identity.frameUrl === pageUrl || identity.frameUrl === live.frameUrl || identity.frameUrl === "";
  }
  if (identity.frameOrigin.length > 0 && live.frameOrigin !== identity.frameOrigin) return false;
  if (identity.frameUrl.length > 0 && live.frameUrl !== identity.frameUrl) return false;
  return true;
}

/** Live elements that are the same control the identity named. Never a reminted ordinal. */
export function resolveControlIdentity(
  elements: readonly InteractiveElement[],
  identity: ActControlIdentity,
  pageUrl = "",
): InteractiveElement | null {
  const wanted = identityKey(identity, pageUrl);
  const matches = elements.filter(
    (el) =>
      framesAlign(el, identity, pageUrl) &&
      identityKey(identityFromInteractiveElement(el, pageUrl), pageUrl) === wanted,
  );
  if (matches.length === 1) return matches[0] ?? null;
  if (matches.length > 1) {
    const bySelector = matches.filter((el) => el.selector === identity.selector);
    if (bySelector.length === 1) return bySelector[0] ?? null;
    return null;
  }
  if (identity.selector.length === 0) return null;
  const selectorHits = elements.filter(
    (el) => el.selector === identity.selector && framesAlign(el, identity, pageUrl),
  );
  if (selectorHits.length !== 1) return null;
  const hit = selectorHits[0]!;
  return identityKey(identityFromInteractiveElement(hit, pageUrl), pageUrl) === wanted ? hit : null;
}

function framePathOf(page: Page, frame: Page | Frame): string | undefined {
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

function scopeForIdentity(page: Page, identity: ActControlIdentity): Page | Frame | null {
  if (identity.frameUrl.length === 0 || identity.frameUrl === page.url()) return page;
  for (const frame of page.frames()) {
    if (frame.url() === identity.frameUrl) return frame;
  }
  return null;
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
  return {
    index: 0,
    tag,
    type: identity.picker === true ? "date" : null,
    id: identity.selector.startsWith("#") ? identity.selector.slice(1) : null,
    name: null,
    placeholder: null,
    ariaLabel: identity.label,
    role,
    labelText: identity.label,
    visibleText: identity.label,
    selector: identity.selector,
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    href: identity.href ?? null,
    frameUrl: identity.frameUrl.length > 0 ? identity.frameUrl : null,
    frameOrigin: identity.frameOrigin.length > 0 ? identity.frameOrigin : null,
    ...(extras?.framePath !== undefined ? { framePath: extras.framePath } : {}),
  };
}

export type LiveControlResolution =
  | { kind: "match"; el: InteractiveElement }
  | { kind: "stale" }
  | { kind: "missing" };

/** Read the live node at `identity.selector` and require the same control. */
export async function liveControlMatchesIdentity(
  page: Page,
  identity: ActControlIdentity,
): Promise<boolean> {
  return (await resolveLiveControlIdentity(page, identity)).kind === "match";
}

/** Live node that is the same control the identity named. Never a reminted ordinal. */
export async function resolveLiveControlIdentity(
  page: Page,
  identity: ActControlIdentity,
): Promise<LiveControlResolution> {
  if (identity.selector.length === 0) return { kind: "missing" };
  const scope = scopeForIdentity(page, identity);
  if (scope === null) return { kind: "stale" };
  const locator = scope.locator(identity.selector).first();
  if ((await locator.count().catch(() => 0)) === 0) return { kind: "missing" };
  try {
    const live = await locator.evaluate((node) => {
      const role =
        node.getAttribute("role") ??
        (node.tagName === "A"
          ? "link"
          : node.tagName === "BUTTON"
            ? "button"
            : node.tagName.toLowerCase());
      const labelled =
        node instanceof HTMLInputElement ||
        node instanceof HTMLTextAreaElement ||
        node instanceof HTMLSelectElement ||
        node instanceof HTMLButtonElement
          ? Array.from(node.labels ?? [])
              .map((label) => (label.textContent ?? "").replace(/\s+/g, " ").trim())
              .filter((part) => part.length > 0)
              .join(" ")
          : "";
      const label =
        (node.getAttribute("aria-label") ?? "").trim() ||
        labelled ||
        (node.textContent ?? "").replace(/\s+/g, " ").trim();
      const href = node instanceof HTMLAnchorElement ? node.href : "";
      return { role, label, href };
    });
    const actual: ActControlIdentity = {
      selector: identity.selector,
      frameUrl: identity.frameUrl,
      frameOrigin: identity.frameOrigin,
      role: canonicalActRole(live.role),
      label: live.label,
      ...(live.href.length > 0 ? { href: live.href } : {}),
    };
    if (!sameControlIdentity(identity, actual, page.url())) return { kind: "stale" };
    const framePath = framePathOf(page, scope);
    return {
      kind: "match",
      el: interactiveFromIdentity(identity, framePath === undefined ? undefined : { framePath }),
    };
  } catch {
    return { kind: "missing" };
  }
}

function uniqueSelector(selector: string): boolean {
  return /^#[A-Za-z][\w-]*$/.test(selector) || /^\[[a-z-]+="/.test(selector);
}

export function sameControlIdentity(
  expected: ActControlIdentity,
  actual: ActControlIdentity,
  pageUrl: string,
): boolean {
  if (identityKey(expected, pageUrl) === identityKey(actual, pageUrl)) return true;
  if (canonicalActRole(expected.role) !== canonicalActRole(actual.role)) return false;
  if (
    normalizeIdentityHref(expected.href, pageUrl) !== normalizeIdentityHref(actual.href, pageUrl)
  ) {
    return false;
  }
  if (uniqueSelector(expected.selector) && expected.selector === actual.selector) return true;
  return normalizeIdentityLabel(expected.label) === normalizeIdentityLabel(actual.label);
}
