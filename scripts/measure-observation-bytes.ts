/** Same-input byte comparison; baseline source comes from git, never a hand-rebuilt oracle.
 * pnpm exec tsx scripts/measure-observation-bytes.ts <baseline-commit>
 * Synthetic reproductions are explicitly separate from the six live captures.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  serializeBrowserUseDOM,
  type BrowserUseNode,
} from "../apps/mcp/src/bot/browser-use-serializer.js";
import { StableObservationRefs } from "../apps/mcp/src/bot/compact-observation-v2.js";
const baseline = process.argv[2];
if (!baseline || !/^[a-f0-9]{7,40}$/.test(baseline))
  throw new Error("Pass the pre-change commit SHA");
const source = execFileSync(
  "git",
  ["show", `${baseline}:apps/mcp/src/bot/browser-use-serializer.ts`],
  { encoding: "utf8" },
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const beforeModule = (await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
)) as { serializeBrowserUseDOM: typeof serializeBrowserUseDOM };
function compare(name: string, root: BrowserUseNode): void {
  const longRef = (n: BrowserUseNode): string =>
    `@e:${createHash("sha256").update(n.id).digest("base64url").slice(0, 10)}`;
  const refs = new StableObservationRefs();
  const before = beforeModule.serializeBrowserUseDOM(root, { ref: longRef }).dom;
  const after = serializeBrowserUseDOM(root, { ref: (n) => refs.get("document", n.id) }).dom;
  const a = Buffer.byteLength(before),
    b = Buffer.byteLength(after);
  console.log(`| ${name} | ${a} | ${b} | ${a - b} | ${(((a - b) / a) * 100).toFixed(1)}% |`);
}
console.log("| Page / reproduction | Before bytes | After bytes | Saved | Reduction |");
console.log("| --- | ---: | ---: | ---: | ---: |");
for (const slug of ["ipinfo", "mdn", "hacker-news", "wikipedia", "github", "gov-uk"])
  compare(
    slug,
    JSON.parse(
      readFileSync(new URL(`../fixtures/browser-use/${slug}.json`, import.meta.url), "utf8"),
    ).root,
  );
let sequence = 0;
const node = (name: string, props: Partial<BrowserUseNode> = {}): BrowserUseNode => ({
  id: String(++sequence),
  nodeType: name === "#text" ? 3 : 1,
  nodeName: name,
  value: "",
  attributes: {},
  visible: true,
  snapshot: true,
  bounds: { x: 0, y: 0, width: 100, height: 100 },
  cursor: null,
  scrollable: false,
  showScroll: false,
  scrollText: "",
  clickListener: false,
  axRole: null,
  axProperties: [],
  axChildIds: [],
  shadowType: null,
  hiddenElements: [],
  hiddenContent: false,
  children: [],
  contentDocument: null,
  ...props,
});
const code = "const key = await client.create({\n  type: 'mandate_signing'\n});";
compare(
  "Highlighted code (synthetic Vouchflow case)",
  node("PRE", {
    children: code
      .split(/(\s+|[(){};])/)
      .filter(Boolean)
      .map((value) =>
        node("SPAN", {
          attributes: { class: "token" },
          bounds: { x: 0, y: 0, width: 20, height: 20 },
          children: [node("#text", { value })],
        }),
      ),
  }),
);
const checks = Array.from({ length: 12 }, () =>
  node("INPUT", { attributes: { type: "checkbox", value: "on" } }),
);
compare(
  "12 repeated checkbox bindings (synthetic Resend case)",
  node("BODY", { children: [...checks, ...checks.map((c) => ({ ...c }))] }),
);
compare(
  "24 distinct unlabelled checkboxes (reachability control)",
  node("BODY", {
    children: Array.from({ length: 24 }, () =>
      node("INPUT", { attributes: { type: "checkbox", value: "on" } }),
    ),
  }),
);
compare(
  "Six hero cards and decorative SVGs (synthetic Xata case)",
  node("BODY", {
    children: Array.from({ length: 6 }, () =>
      node("DIV", {
        children: [
          node("SVG"),
          ...["PR #846 / Cart totals", "Preview / search-v2", "Claude task / Backfill data"].map(
            (value) => node("#text", { value }),
          ),
        ],
      }),
    ),
  }),
);
