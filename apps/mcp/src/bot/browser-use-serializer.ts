import { browserUsePaintOrder } from "./browser-use-paint-order.js";
/**
 * TypeScript port of browser-use 0.13.10's DOMTreeSerializer.
 * Oracle: scripts/capture-browser-use.py; fixtures/browser-use/*.txt.
 * Upstream: https://github.com/browser-use/browser-use (MIT).
 * Identity is supplied by the caller; all rendering retains DOM order.
 */
export interface DOMBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface BrowserUseNode {
  id: string;
  nodeType: number;
  nodeName: string;
  value: string;
  attributes: Record<string, string>;
  visible: boolean;
  snapshot: boolean;
  bounds: DOMBounds | null;
  cursor: string | null;
  paintOrder?: number | null;
  computedStyles?: Record<string, string> | null;
  scrollable: boolean;
  showScroll: boolean;
  scrollText: string;
  clickListener: boolean;
  axRole: string | null;
  axProperties: Array<{ name: string; value: unknown }>;
  axChildIds: unknown[] | null;
  shadowType: string | null;
  hiddenElements: Array<{
    tag: string;
    text: string;
    pages: number | string;
    interactive?: boolean;
  }>;
  hiddenContent: boolean;
  children: BrowserUseNode[];
  contentDocument: BrowserUseNode | null;
}
interface Simplified {
  original: BrowserUseNode;
  children: Simplified[];
  excluded: boolean;
  interactive: boolean;
  shadowHost: boolean;
  compound: string;
  isNew: boolean;
  code?: string;
}
export const DEFAULT_CONTAINMENT_THRESHOLD = 0.99;
const DISABLED = new Set(["style", "script", "head", "meta", "link", "title"]);
const SVG = new Set([
  "path",
  "rect",
  "g",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "use",
  "defs",
  "clipPath",
  "mask",
  "pattern",
  "image",
  "text",
  "tspan",
]);
const ATTRIBUTES = new Set([
  "title",
  "type",
  "checked",
  "id",
  "name",
  "role",
  "value",
  "placeholder",
  "data-date-format",
  "alt",
  "aria-label",
  "aria-expanded",
  "data-state",
  "aria-checked",
  "aria-valuemin",
  "aria-valuemax",
  "aria-valuenow",
  "aria-placeholder",
  "pattern",
  "min",
  "max",
  "minlength",
  "maxlength",
  "step",
  "accept",
  "multiple",
  "inputmode",
  "autocomplete",
  "aria-autocomplete",
  "list",
  "data-mask",
  "data-inputmask",
  "data-datepicker",
  "format",
  "expected_format",
  "contenteditable",
  "pseudo",
  "selected",
  "expanded",
  "pressed",
  "disabled",
  "invalid",
  "valuemin",
  "valuemax",
  "valuenow",
  "keyshortcuts",
  "haspopup",
  "multiselectable",
  "required",
  "valuetext",
  "level",
  "busy",
  "live",
  "ax_name",
]);
const tag = (n: BrowserUseNode): string => (n.nodeType === 1 ? n.nodeName.toLowerCase() : "");
const formTags = new Set(["input", "select", "textarea"]);
const broadContextTags = new Set([
  "article",
  "aside",
  "body",
  "footer",
  "header",
  "html",
  "main",
  "nav",
  "section",
]);
const interactiveRoles = new Set([
  "button",
  "link",
  "menuitem",
  "option",
  "radio",
  "checkbox",
  "tab",
  "textbox",
  "combobox",
  "slider",
  "spinbutton",
  "search",
  "searchbox",
  "row",
  "cell",
  "gridcell",
]);
const cap = (s: string, n = 100): string =>
  Array.from(s).length <= n ? s : Array.from(s).slice(0, n).join("") + "...";
const pyString = (v: unknown): string =>
  v === null ? "None" : typeof v === "boolean" ? (v ? "True" : "False") : String(v);

export function browserUseInteractive(n: BrowserUseNode): boolean {
  const t = tag(n),
    a = n.attributes;
  if (n.nodeType !== 1 || t === "html" || t === "body") return false;
  if (n.clickListener) return true;
  if (
    (t === "iframe" || t === "frame") &&
    n.bounds &&
    n.bounds.width > 100 &&
    n.bounds.height > 100
  )
    return true;
  const hasForm = (node: BrowserUseNode, depth: number): boolean =>
    depth > 0 &&
    node.children.some((c) => c.nodeType === 1 && (formTags.has(tag(c)) || hasForm(c, depth - 1)));
  if (t === "label" && a.for) return false;
  if ((t === "label" || t === "span") && hasForm(n, 2)) return true;
  const search = [
    "search",
    "magnify",
    "glass",
    "lookup",
    "find",
    "query",
    "search-icon",
    "search-btn",
    "search-button",
    "searchbox",
  ];
  if (
    [
      a.class ?? "",
      a.id ?? "",
      ...Object.entries(a)
        .filter(([k]) => k.startsWith("data-"))
        .map(([, v]) => v),
    ].some((v) => search.some((s) => v.toLowerCase().includes(s)))
  )
    return true;
  for (const p of n.axProperties) {
    if (["disabled", "hidden"].includes(p.name) && p.value) return false;
    if (
      ["focusable", "editable", "settable", "required", "autocomplete", "keyshortcuts"].includes(
        p.name,
      ) &&
      p.value
    )
      return true;
    if (["checked", "expanded", "pressed", "selected"].includes(p.name)) return true;
  }
  if (
    [
      "button",
      "input",
      "select",
      "textarea",
      "a",
      "details",
      "summary",
      "option",
      "optgroup",
    ].includes(t)
  )
    return true;
  if (
    ["onclick", "onmousedown", "onmouseup", "onkeydown", "onkeyup", "tabindex"].some((k) => k in a)
  )
    return true;
  if (
    interactiveRoles.has(a.role ?? "") ||
    interactiveRoles.has(n.axRole ?? "") ||
    n.axRole === "listbox"
  )
    return true;
  if (
    n.bounds &&
    n.bounds.width >= 10 &&
    n.bounds.width <= 50 &&
    n.bounds.height >= 10 &&
    n.bounds.height <= 50 &&
    ["class", "role", "onclick", "data-action", "aria-label"].some((k) => k in a)
  )
    return true;
  return n.cursor === "pointer";
}
export function browserUseLocalContextContainer(
  n: BrowserUseNode,
  hasActionableDescendant: boolean,
): boolean {
  const t = tag(n);
  return (
    ["tr", "li", "fieldset", "label"].includes(t) ||
    n.attributes.role === "row" ||
    (hasActionableDescendant && !broadContextTags.has(t))
  );
}
export function browserUseBoundedContextText(n: BrowserUseNode, limit: number): string | null {
  const characters: string[] = [];
  let textStarted = false,
    pendingSpace = false;
  const append = (character: string): boolean => {
    if (/\s/.test(character)) {
      pendingSpace ||= textStarted;
      return true;
    }
    if (pendingSpace) {
      characters.push(" ");
      pendingSpace = false;
    }
    characters.push(character);
    textStarted = true;
    return characters.length <= limit;
  };
  const visit = (current: BrowserUseNode): boolean => {
    if (current.nodeType === 3) {
      for (const character of current.value) if (!append(character)) return false;
      return true;
    }
    let sawChild = false;
    for (const child of current.children) {
      if (sawChild && textStarted) pendingSpace = true;
      sawChild = true;
      if (!visit(child)) return false;
    }
    return true;
  };
  return visit(n) ? characters.join("") : null;
}
export function browserUseOrderedHeadingContext<T>(
  children: readonly T[],
  enclosing: string,
  heading: (node: T) => string | null,
  visit: (node: T, context: string) => string | null,
): string | null {
  let context = enclosing,
    lastHeading: string | null = null;
  for (const child of children) {
    const directHeading = heading(child);
    const nestedHeading = visit(child, directHeading || context);
    if (nestedHeading) {
      context = nestedHeading;
      lastHeading = nestedHeading;
    }
  }
  return lastHeading;
}
function propagates(n: BrowserUseNode): boolean {
  const t = tag(n),
    r = n.attributes.role;
  return (
    t === "a" ||
    t === "button" ||
    ((t === "div" || t === "span") && (r === "button" || r === "combobox")) ||
    (t === "input" && r === "combobox")
  );
}
export function browserUseContained(child: DOMBounds, parent: DOMBounds): boolean {
  const area = child.width * child.height;
  return (
    area > 0 &&
    (Math.max(
      0,
      Math.min(child.x + child.width, parent.x + parent.width) - Math.max(child.x, parent.x),
    ) *
      Math.max(
        0,
        Math.min(child.y + child.height, parent.y + parent.height) - Math.max(child.y, parent.y),
      )) /
      area >=
      DEFAULT_CONTAINMENT_THRESHOLD
  );
}
function exclude(n: BrowserUseNode, bounds: DOMBounds): boolean {
  const t = tag(n),
    a = n.attributes;
  return (
    n.nodeType !== 3 &&
    n.bounds !== null &&
    browserUseContained(n.bounds, bounds) &&
    !["input", "select", "textarea", "label"].includes(t) &&
    !propagates(n) &&
    !("onclick" in a) &&
    !(a["aria-label"] ?? "").trim() &&
    !["button", "link", "checkbox", "radio", "tab", "menuitem", "option"].includes(a.role ?? "")
  );
}
function attributes(n: BrowserUseNode, localState = false): string {
  const a: Record<string, string> = {};
  for (const [k, v] of Object.entries(n.attributes))
    if (
      (ATTRIBUTES.has(k) || (localState && ["aria-pressed", "aria-selected"].includes(k))) &&
      v.trim()
    )
      a[k] = v.trim();
  const t = tag(n),
    type = (n.attributes.type ?? "").toLowerCase();
  const formats: Record<string, string> = {
    date: "YYYY-MM-DD",
    time: "HH:MM",
    "datetime-local": "YYYY-MM-DDTHH:MM",
    month: "YYYY-MM",
    week: "YYYY-W##",
  };
  if (t === "input") {
    if (formats[type]) a.format = formats[type]!;
    if (!("placeholder" in a)) {
      if (formats[type]) a.placeholder = formats[type]!;
      else if (type === "tel" && !a.pattern) a.placeholder = "123-456-7890";
      else if (type === "text" || !type) {
        const attrs = n.attributes;
        if ("uib-datepicker-popup" in attrs) {
          if (attrs["uib-datepicker-popup"])
            a.expected_format = a.format = attrs["uib-datepicker-popup"]!;
        } else if (
          ["datepicker", "datetimepicker", "daterangepicker"].some((s) =>
            (attrs.class ?? "").toLowerCase().includes(s),
          ) ||
          "data-datepicker" in attrs
        )
          a.placeholder = a.format = attrs["data-date-format"] || "mm/dd/yyyy";
      }
    }
  }
  const password = t === "input" && type === "password";
  for (const p of n.axProperties)
    if (
      ATTRIBUTES.has(p.name) &&
      p.value !== null &&
      !(password && ["value", "valuetext"].includes(p.name))
    ) {
      const v = typeof p.value === "boolean" ? String(p.value) : pyString(p.value).trim();
      if (v) a[p.name] = v;
    }
  if (formTags.has(t)) {
    if (password) delete a.value;
    else
      for (const p of n.axProperties)
        if (["valuetext", "value"].includes(p.name) && p.value && pyString(p.value).trim()) {
          a.value = pyString(p.value).trim();
          break;
        }
  }
  const seen = new Set<string>();
  for (const k of ATTRIBUTES)
    if (k in a && a[k]!.length > 5) {
      if (
        seen.has(a[k]!) &&
        !["format", "expected_format", "placeholder", "value", "aria-label", "title"].includes(k)
      )
        delete a[k];
      else seen.add(a[k]!);
    }
  if (n.axRole && n.nodeName === n.axRole) delete a.role;
  if (a.type?.toLowerCase() === n.nodeName.toLowerCase()) delete a.type;
  if (a.invalid?.toLowerCase() === "false") delete a.invalid;
  if (["false", "0", "no"].includes(a.required?.toLowerCase() ?? "")) delete a.required;
  if ("expanded" in a && "aria-expanded" in a) delete a["aria-expanded"];
  return Object.entries(a)
    .map(([k, v]) => {
      return `${k}=${cap(v) || "''"}`;
    })
    .join(" ");
}
function compounds(n: BrowserUseNode): string {
  const t = tag(n),
    type = n.attributes.type,
    a = n.attributes;
  if (
    !["input", "select", "details", "audio", "video"].includes(t) ||
    (t !== "input" && !n.axChildIds?.length)
  )
    return "";
  const c = (name: string, role: string, tail = ""): string => `(name=${name},role=${role}${tail})`;
  const number = (s: string | undefined, fallback?: number): string | undefined => {
    const x = s?.trim() ? Number(s) : fallback;
    return x === undefined || !Number.isFinite(x)
      ? fallback === undefined
        ? undefined
        : fallback.toFixed(1)
      : Number.isInteger(x)
        ? x.toFixed(1)
        : String(x);
  };
  const bounds = (min?: string, max?: string): string =>
    `${min === undefined ? "" : ",min=" + min}${max === undefined ? "" : ",max=" + max}`;
  if (t === "input") {
    if (type === "range") return c("Value", "slider", bounds(number(a.min, 0), number(a.max, 100)));
    if (type === "number")
      return [
        c("Increment", "button"),
        c("Decrement", "button"),
        c("Value", "textbox", bounds(number(a.min), number(a.max))),
      ].join(",");
    if (type === "color") return [c("Hex Value", "textbox"), c("Color Picker", "button")].join(",");
    if (type === "file") {
      let value = "None";
      for (const p of n.axProperties) {
        if (
          p.name === "valuetext" &&
          p.value &&
          !["", "no file chosen", "no file selected"].includes(String(p.value).trim().toLowerCase())
        ) {
          value = String(p.value).trim();
          break;
        }
        if (p.name === "value" && p.value) {
          value = String(p.value).trim().split(/[\\/]/).pop()!;
          break;
        }
      }
      return [
        c("Browse Files", "button"),
        c("multiple" in a ? "Files Selected" : "File Selected", "textbox", `,current=${value}`),
      ].join(",");
    }
    return "";
  }
  if (t === "select") {
    const opts: Array<{ text: string; value: string }> = [];
    const walk = (x: BrowserUseNode): void => {
      if (tag(x) === "option") {
        const text = x.children
          .filter((k) => k.nodeType === 3)
          .map((k) => k.value.trim())
          .join(" ")
          .trim();
        const value = (x.attributes.value ?? "").trim() || text;
        if (text || value) opts.push({ text, value });
      } else x.children.forEach(walk);
    };
    n.children.forEach(walk);
    let tail = "";
    if (opts.length) {
      tail = `,count=${opts.length},options=${opts
        .slice(0, 4)
        .map((o) => cap(o.text || o.value, 30))
        .join("|")}`;
      if (opts.length >= 2) {
        const v = opts
          .slice(0, 5)
          .map((o) => o.value)
          .filter(Boolean);
        const format = v.every((s) => /^\d+$/.test(s))
          ? "numeric"
          : v.every((s) => s.length === 2 && s.toUpperCase() === s && s.toLowerCase() !== s)
            ? "country/state codes"
            : v.every((s) => /[/-]/.test(s))
              ? "date/path format"
              : v.some((s) => s.includes("@"))
                ? "email addresses"
                : "";
        if (format) tail += `,format=${format}`;
      }
    }
    return [c("Dropdown Toggle", "button"), c("Options", "listbox", tail)].join(",");
  }
  if (t === "details")
    return [c("Toggle Disclosure", "button"), c("Content Area", "region")].join(",");
  return [
    c("Play/Pause", "button"),
    c("Progress", "slider", ",min=0,max=100"),
    c("Mute", "button"),
    c("Volume", "slider", ",min=0,max=100"),
    ...(t === "video" ? [c("Fullscreen", "button")] : []),
  ].join(",");
}
function imageContext(n: Simplified): string {
  const result: string[] = [];
  let visited = 0;
  const walk = (s: Simplified, root = false): void => {
    if ((!root && ++visited > 100) || result.length >= 3) return;
    const o = s.original,
      a = o.attributes;
    if (tag(o) === "img") {
      const parts: string[] = [];
      for (const [key, name] of [
        ["alt", "image_alt"],
        ["title", "image_title"],
        ["aria-label", "image_label"],
      ] as const)
        if ((a[key] ?? "").length <= 4096 && a[key]?.trim())
          parts.push(`${name}=${cap(a[key]!.trim())}`);
      let src = a.src ?? "";
      if (src.length <= 4096) {
        src = src.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "").replace(/[\t\n\r]/g, "");
        if (!src.toLowerCase().startsWith("data:")) {
          src = src.split("?")[0]!.split("#")[0]!.replace(/\/+$/, "").split("/").pop()!;
          if (src) parts.push(`image_src=${cap(src)}`);
        }
      }
      if (parts.length) result.push(parts.join(" "));
    }
    for (const c of s.children) {
      if (visited >= 100 || result.length >= 3) break;
      walk(c);
    }
  };
  walk(n, true);
  return result.join(" ");
}

/** Syntax markup is presentation. Explicit action semantics always win. */
function codeText(n: BrowserUseNode, paintedOver?: ReadonlySet<BrowserUseNode>): string | null {
  if (!["pre", "code"].includes(tag(n)) || !n.visible) return null;
  let actionable = false;
  const collect = (c: BrowserUseNode, root = false): string => {
    if (c.nodeType === 3)
      return !paintedOver?.has(c) && (c.visible || /^\s*$/.test(c.value)) ? c.value : "";
    if (c.nodeType === 11) actionable = true;
    if (c.nodeType !== 1 || DISABLED.has(tag(c))) return "";
    if (!root && paintedOver?.has(c)) return "";
    // Neutralize only the canonical small-icon class/id heuristic on markup.
    const plainMarkup =
      ["pre", "code", "span", "div"].includes(tag(c)) &&
      Object.keys(c.attributes).every((k) => ["class", "style", "id"].includes(k));
    const actual = plainMarkup ? { ...c, bounds: null } : c;
    if (browserUseInteractive(actual) || c.scrollable || c.shadowType || c.contentDocument)
      actionable = true;
    return c.children.map((child) => collect(child)).join("");
  };
  const value = collect(n, true);
  return actionable ? null : value;
}

/** No text budget or reordering: filtering preserves the original DOM sequence. */
export function serializeBrowserUseDOM(
  root: BrowserUseNode,
  options: {
    ref?: (node: BrowserUseNode) => string | { ref: string; targetable: boolean };
    previous?: ReadonlySet<string>;
    /** Oracle comparison only: omit local byte filters/reachability exceptions. */
    canonical?: boolean;
  } = {},
): { dom: string; refs: string[] } {
  const efficient = !options.canonical;
  const targets = new Map<Simplified, { ref: string; targetable: boolean }>();
  const actionDescendants = new Map<BrowserUseNode, boolean>();
  const containsAction = (node: BrowserUseNode): boolean => {
    if (!actionDescendants.has(node))
      actionDescendants.set(
        node,
        browserUseInteractive(node) || node.children.some(containsAction),
      );
    return actionDescendants.get(node)!;
  };
  const simplify = (n: BrowserUseNode): Simplified | null => {
    if (n.nodeType === 9) {
      for (const c of n.children) {
        const s = simplify(c);
        if (s) return s;
      }
      return null;
    }
    if (n.nodeType === 3)
      return n.snapshot && n.visible && n.value.trim().length > 1
        ? {
            original: n,
            children: [],
            excluded: false,
            interactive: false,
            shadowHost: false,
            compound: "",
            isNew: false,
          }
        : null;
    if (n.nodeType !== 1 && n.nodeType !== 11) return null;
    const t = tag(n);
    if (
      DISABLED.has(t) ||
      (SVG.has(t) && !(efficient && containsAction(n))) ||
      n.attributes["data-browser-use-exclude"]?.toLowerCase() === "true"
    )
      return null;
    const code = efficient ? codeText(n) : null;
    const children = (
      (t === "iframe" || t === "frame") && n.contentDocument
        ? n.contentDocument.children
        : n.children
    )
      .map(simplify)
      .filter((c): c is Simplified => c !== null);
    const shadowHost = n.children.some((c) => c.nodeType === 11);
    if (
      !(
        (n.snapshot && n.visible) ||
        n.scrollable ||
        children.length ||
        (t === "input" && n.attributes.type === "file")
      )
    )
      return null;
    return {
      original: n,
      children,
      excluded: false,
      interactive: false,
      shadowHost,
      ...(code === null ? {} : { code }),
      compound: compounds(n),
      isNew: false,
    };
  };
  const tree = simplify(root);
  if (!tree)
    return { dom: "Empty DOM tree (you might have to wait for the page to load)", refs: [] };
  const filter = (n: Simplified, active: DOMBounds | null): void => {
    n.excluded = active !== null && exclude(n.original, active);
    const next = propagates(n.original) && n.original.bounds ? n.original.bounds : active;
    n.children.forEach((c) => filter(c, next));
  };
  filter(tree, null);
  const paintedOver = browserUsePaintOrder(tree);
  const refs: string[] = [];
  const hasInteractive = (n: Simplified): boolean =>
    n.children.some((c) => browserUseInteractive(c.original) || hasInteractive(c));
  const assign = (n: Simplified, inShadow: boolean): void => {
    const o = n.original,
      t = tag(o),
      a = o.attributes;
    if (n.code === undefined && !n.excluded && (!paintedOver.has(o) || efficient)) {
      if (o.scrollable)
        n.interactive =
          ["listbox", "menu", "combobox", "menubar", "tree", "grid"].includes(a.role ?? "") ||
          t === "select" ||
          (a.class ?? "")
            .split(/\s+/)
            .some((c) => ["dropdown", "dropdown-menu", "select-menu"].includes(c)) ||
          ((a.class ?? "").split(/\s+/).includes("ui") && (a.class ?? "").includes("dropdown")) ||
          !hasInteractive(n);
      else
        n.interactive =
          browserUseInteractive(o) &&
          ((o.snapshot && o.visible) ||
            (t === "input" && a.type === "file") ||
            (!o.snapshot &&
              inShadow &&
              ["input", "button", "select", "textarea", "a"].includes(t)));
    }
    if (n.interactive) {
      const resolved = options.ref?.(o) ?? o.id;
      const target = typeof resolved === "string" ? { ref: resolved, targetable: true } : resolved;
      targets.set(n, target);
      const ref = target.ref;
      if (!refs.includes(ref)) refs.push(ref);
      n.isNew = !!n.compound || (!!options.previous?.size && !options.previous.has(ref));
    }
    if (n.code === undefined) n.children.forEach((c) => assign(c, inShadow || o.nodeType === 11));
  };
  assign(tree, false);
  // Compare unscreened content, never let redaction make different rows identical.
  // "Near identical" is deliberately limited to whitespace differences; numbers,
  // names, prices, and statuses remain meaningful differences.
  const protectedCache = new Map<Simplified, boolean>();
  const protectedTree = (n: Simplified): boolean => {
    if (!protectedCache.has(n))
      protectedCache.set(
        n,
        n.interactive ||
          browserUseInteractive(n.original) ||
          n.original.scrollable ||
          n.original.nodeType === 11 ||
          ["iframe", "frame"].includes(tag(n.original)) ||
          n.children.some(protectedTree),
      );
    return protectedCache.get(n)!;
  };
  const keyCache = new Map<Simplified, number>();
  const structures = new Map<string, number>();
  const repetitionKey = (n: Simplified): number => {
    if (!keyCache.has(n)) {
      const signature = JSON.stringify([
        n.code,
        n.original.nodeType,
        n.original.nodeName,
        n.original.value.replace(/\s+/g, " ").trim(),
        Object.entries(n.original.attributes)
          .filter(([key]) => !["id", "class", "style"].includes(key))
          .sort(([a], [b]) => a.localeCompare(b)),
        n.original.visible,
        paintedOver.has(n.original),
        n.children.map(repetitionKey),
      ]);
      const key = structures.get(signature) ?? structures.size;
      structures.set(signature, key);
      keyCache.set(n, key);
    }
    return keyCache.get(n)!;
  };
  const contexts = new Map<Simplified, string>();
  const genericContextMaxChars = 120;
  const containsActionableDescendant = (n: Simplified): boolean =>
    n.children.some((child) => containsAction(child.original));
  const headingContext = (n: Simplified): string | null =>
    /^h[1-6]$/.test(tag(n.original))
      ? browserUseBoundedContextText(n.original, genericContextMaxChars)
      : null;
  const contextualize = (n: Simplified, enclosing = ""): string | null => {
    const o = n.original,
      t = tag(o);
    const text = browserUseBoundedContextText(o, genericContextMaxChars);
    const container =
      browserUseLocalContextContainer(o, containsActionableDescendant(n)) && text !== null;
    const directHeading = headingContext(n);
    let context = container ? text || enclosing : directHeading || enclosing;
    contexts.set(n, context);
    if (["iframe", "frame"].includes(t)) context = "";
    const nestedHeading = browserUseOrderedHeadingContext(
      n.children,
      context,
      headingContext,
      contextualize,
    );
    return directHeading || nestedHeading;
  };
  if (efficient) contextualize(tree);
  const emittedTargets = new Set<string>();
  const stateIconCache = new Map<BrowserUseNode, string[]>();
  const selectionToken = (value: string | undefined): boolean =>
    /(?:^|[-_\s])(?:check(?:mark)?|selected|tick)(?:$|[-_\s])/i.test(value ?? "");
  const stateIconEvidence = (child: BrowserUseNode): string | null => {
    const namedEvidence = [
      child.attributes["aria-label"],
      child.attributes["data-icon"],
      child.attributes.class,
    ].find(selectionToken);
    if (namedEvidence) return namedEvidence;
    const ariaState = ["aria-checked", "aria-pressed", "aria-selected"]
      .map((attribute) => [attribute, child.attributes[attribute]?.trim()] as const)
      .find(([, value]) => value);
    if (ariaState) return `${ariaState[0]}=${ariaState[1]}`;
    const dataState = child.attributes["data-state"]?.trim();
    if (selectionToken(dataState)) return `data-state=${dataState}`;
    const glyph = browserUseBoundedContextText(child, 4)?.replace(/\s+/g, "");
    return glyph && /^[✓✔☑✅]+$/.test(glyph) ? glyph : null;
  };
  const stateIcons = (node: BrowserUseNode): string[] => {
    if (!stateIconCache.has(node)) {
      const icons: string[] = [];
      const collect = (child: BrowserUseNode): void => {
        if (!child.visible || child.contentDocument) return;
        const evidence = stateIconEvidence(child);
        if (evidence) {
          icons.push(evidence);
          return;
        }
        if (child.clickListener || ["button", "input", "select", "a"].includes(tag(child))) return;
        child.children.forEach(collect);
      };
      node.children.forEach(collect);
      stateIconCache.set(node, icons);
    }
    return stateIconCache.get(node)!;
  };
  const selectionClass = (node: BrowserUseNode): string | null => {
    const className = node.attributes.class?.trim();
    return /(?:^|[-_\s])(?:selected|checked|tick)(?:$|[-_\s])/i.test(className ?? "")
      ? className!
      : null;
  };
  const selectionEvidence = (node: BrowserUseNode) => ({
    className: selectionClass(node),
    icons: stateIcons(node),
    state: ["aria-checked", "aria-pressed", "aria-selected", "data-state"].some((attribute) =>
      node.attributes[attribute]?.trim(),
    ),
  });
  const render = (n: Simplified, depth: number): string => {
    const o = n.original,
      t = tag(o),
      indent = "\t".repeat(depth);
    if (n.code !== undefined) {
      const code = codeText(o, paintedOver);
      return code ? `${indent}<${t}> ${JSON.stringify(code)}` : "";
    }
    // A duplicate binding cannot add reachability. Only omit an empty form row
    // when its exact action identity was already emitted; never infer equivalence
    // from matching labels, checked state, values or position.
    const target = targets.get(n);
    if (
      efficient &&
      target?.targetable &&
      formTags.has(t) &&
      n.children.length === 0 &&
      !["aria-label", "title", "placeholder", "name", "id"].some((key) =>
        o.attributes[key]?.trim(),
      ) &&
      emittedTargets.has(target.ref)
    )
      return "";
    if (target) emittedTargets.add(target.ref);
    if (n.excluded)
      return n.children
        .map((c) => render(c, depth))
        .filter(Boolean)
        .join("\n");
    const lines: string[] = [];
    let next = depth;
    const shadow = n.shadowHost
      ? `|SHADOW(${n.children.some((c) => c.original.shadowType?.toLowerCase() === "closed") ? "closed" : "open"})|`
      : "";
    const marker = n.interactive
      ? `${n.isNew ? "*" : ""}${o.showScroll && t !== "svg" ? "|scroll element[" : "["}${targets.get(n)!.ref}]`
      : "";
    if (o.nodeType === 1) {
      let attrs = attributes(o, efficient);
      if (efficient && n.interactive) {
        const evidence = selectionEvidence(o);
        if (evidence.className || evidence.icons.length || evidence.state) {
          if (evidence.className)
            attrs += (attrs ? " " : "") + `state_class=${JSON.stringify(evidence.className)}`;
          if (evidence.icons.length)
            attrs += (attrs ? " " : "") + `state_icons=${JSON.stringify(evidence.icons)}`;
        }
      }
      if (
        efficient &&
        n.interactive &&
        contexts.get(n) &&
        !["aria-label", "title", "placeholder", "ax_name"].some((key) =>
          o.attributes[key]?.trim(),
        ) &&
        browserUseBoundedContextText(o, 1) === ""
      )
        attrs += (attrs ? " " : "") + `context=${cap(contexts.get(n)!)}`;
      if (n.interactive && targets.get(n)?.targetable === false)
        attrs += (attrs ? " " : "") + "not-targetable=true";
      if (t === "svg" && !(efficient && hasInteractive(n)))
        return efficient &&
          !n.interactive &&
          (paintedOver.has(o) ||
            !(o.attributes["aria-label"] || o.attributes.alt || o.attributes.title)?.trim())
          ? ""
          : `${indent}${shadow}${marker}<svg${attrs ? " " + attrs : ""} /> <!-- SVG content collapsed -->`;
      if (n.interactive || o.scrollable || t === "iframe" || t === "frame") {
        next++;
        if (n.interactive) {
          const img = imageContext(n);
          if (img) attrs += (attrs ? " " : "") + img;
        }
        if (n.compound) attrs += (attrs ? " " : "") + `compound_components=${n.compound}`;
        const prefix =
          o.showScroll && !n.interactive
            ? "|scroll element|"
            : n.interactive
              ? marker
              : t === "iframe"
                ? "|IFRAME|"
                : t === "frame"
                  ? "|FRAME|"
                  : "";
        lines.push(
          `${indent}${shadow}${prefix}<${t}${attrs ? " " + attrs : ""} />${o.showScroll && o.scrollText ? " (" + o.scrollText + ")" : ""}`,
        );
      }
    } else if (o.nodeType === 11) {
      lines.push(
        indent + (o.shadowType?.toLowerCase() === "closed" ? "Closed Shadow" : "Open Shadow"),
      );
      next++;
    } else if (
      o.nodeType === 3 &&
      o.snapshot &&
      o.visible &&
      !paintedOver.has(o) &&
      o.value.trim().length > 1
    )
      lines.push(indent + o.value.trim());
    for (let i = 0; i < n.children.length; i++) {
      const child = n.children[i]!;
      const line = render(child, next);
      if (!line) continue;
      let count = 1;
      if (efficient && !protectedTree(child)) {
        const key = repetitionKey(child);
        while (
          i + count < n.children.length &&
          !protectedTree(n.children[i + count]!) &&
          repetitionKey(n.children[i + count]!) === key
        )
          count++;
      }
      lines.push(line + (count > 1 ? ` [repeated ×${count}]` : ""));
      i += count - 1;
    }
    if (o.nodeType === 11 && n.children.length) lines.push(indent + "Shadow End");
    if (t === "iframe" || t === "frame") {
      const hidden = o.hiddenElements.filter(
        (e) =>
          !efficient ||
          e.interactive !== false ||
          (e.text.trim() !== "" && e.text.trim() !== "(no label)"),
      );
      if (hidden.length) {
        lines.push(`${indent}... (${hidden.length} more elements below - scroll to reveal):`);
        for (const e of hidden)
          lines.push(`${indent}    <${e.tag}> "${cap(e.text, 40)}" ~${e.pages} pages down`);
      } else if (o.hiddenContent)
        lines.push(`${indent}... (more content below viewport - scroll to reveal)`);
    }
    return lines.join("\n");
  };
  return { dom: render(tree, 0), refs };
}
