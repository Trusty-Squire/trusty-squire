// Widget-driving eval over the REAL captured onboarding corpus.
//
// Why this exists: reviews of widget-driving operate_act kinds (select /
// set_phone_country) kept looping on HYPOTHESES about widget DOM shapes with
// no executable ground truth. The corpus (~15k captures, each carrying the
// full page HTML + the walked element inventory) IS that ground truth: this
// eval replays real captured DOMs in Chromium and runs the real primitives
// (BrowserController.extractInteractiveElements + selectOption) against them.
//
// ── HONEST SCOPE — what a replayed static DOM can and cannot prove ──
// The captured HTML is replayed via page.setContent with JavaScript DISABLED
// and every external resource load aborted (deterministic, offline). There is
// NO live framework JS, so custom dropdowns (react-select, Radix, Base UI
// popovers) will not actually open or commit on click. What IS a static-DOM
// question, and is validated here:
//   (a) target detection & locality — which node a primitive WOULD drive:
//       inventory selectors resolve uniquely, distinct inventory rows denote
//       distinct nodes, phone-country triggers are custom widgets DISTINCT
//       from any native <select> on the page (so a select-driving default
//       could never silently hit e.g. an address-country select), and
//       driving one select never disturbs a sibling select.
//   (b) native <select> driving — the option value is actually set on the
//       real DOM node and read back for verification.
//   (c) loud-failure contracts — a missing target or a custom widget that
//       cannot open must THROW, never report false success. (One KNOWN GAP
//       is pinned as a test below: native-select no-match silently falls
//       back to the first real option instead of throwing.)
// What it CANNOT validate: dynamic open/commit behavior of custom widgets
// (combobox popovers, phone-country dialogs). That residual gap belongs to
// live smoke tests, not this harness.
//
// The eval doubles as a corpus census — every run prints records scanned /
// matched per category / assertions run.
//
// Skips gracefully (with a logged count) when the corpus directory is absent
// — CI machines don't have it. Env knobs:
//   TRUSTY_SQUIRE_CORPUS_DIR   corpus location (default
//                              ~/.trusty-squire/corpus/onboarding; "off"/"0"
//                              disables the eval)
//   WIDGET_EVAL_MAX_RECORDS    per-category replay cap (default 12)
//
// setPhoneCountry is NOT exercised: it is not exported on main yet. The
// phone-country suite below already classifies + replays the records a
// setPhoneCountry eval needs (see "phone-country signals"); when the
// primitive lands, wire it into that suite.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { BrowserController, type InteractiveElement } from "../browser.js";
import {
  resolveCorpusDir,
  scanCorpus,
  loadRecord,
  hasDialCodeSelect,
  hasCountryCodeTrigger,
  isDialCodeTriggerText,
  sampleEvenly,
  parsePositiveInt,
  type CorpusScan,
  type CorpusRecord,
} from "./helpers/corpus.js";

const corpusDir = resolveCorpusDir();
const MAX_RECORDS = parsePositiveInt(process.env.WIDGET_EVAL_MAX_RECORDS) ?? 12;

// Always-run visibility: when the corpus is absent the whole eval silently
// skipping would look like coverage that isn't there. Log the skip loudly.
it("widget-corpus-eval corpus availability", () => {
  if (corpusDir === null) {
    console.log(
      "[widget-corpus-eval] corpus absent or disabled " +
        "(TRUSTY_SQUIRE_CORPUS_DIR / ~/.trusty-squire/corpus/onboarding) — " +
        "0 records scanned, all replay suites skipped.",
    );
  } else {
    console.log(`[widget-corpus-eval] corpus: ${corpusDir} (cap ${MAX_RECORDS}/category)`);
  }
  expect(true).toBe(true);
});

describe.skipIf(corpusDir === null)("widget corpus eval (real captured DOMs)", () => {
  let browser: Browser;
  let context: BrowserContext;
  let scan: CorpusScan;
  // Parsed tel-bearing records (small set) — reused by the phone suite.
  let telRecords: CorpusRecord[] = [];

  beforeAll(async () => {
    if (corpusDir === null) return;
    scan = scanCorpus(corpusDir);
    telRecords = scan.telInputFiles
      .map((f) => loadRecord(f))
      .filter((r): r is CorpusRecord => r !== null);
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    // JS disabled: the replay is a STATIC snapshot by design (see honest-scope
    // note above) — captured app bundles must not run half-broken against a
    // detached backend. Playwright's own evaluate/injected script still works.
    context = await browser.newContext({ javaScriptEnabled: false });
    // Determinism/no-network: abort every subresource fetch (external CSS,
    // images, fonts). Layout therefore differs from the live page; every
    // visibility judgment below is made self-consistently on the REPLAYED DOM
    // by the real walker.
    await context.route("**/*", (route) => route.abort());
  }, 300_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
  });

  // Replay one capture. The controller's page is normally created by
  // .start(), which does geo-probing + a persistent-profile Chrome launch —
  // unsuitable here. Inject a directly-created page so the REAL walker and
  // selectOption run against real Chromium. Mirrors the private-field access
  // pattern in shadow-dom-topmost.test.ts / browser-humanize.test.ts.
  async function openRecord(rec: CorpusRecord): Promise<{ ctrl: BrowserController; page: Page }> {
    const page = await context.newPage();
    // Meta-refresh fires even with page JS disabled: a captured redirect /
    // interstitial page navigates mid-replay and destroys the execution
    // context under the walker. Neutralizing it is the ONLY mutation the
    // replay makes to captured HTML.
    const html = rec.html.replace(/<meta[^>]*http-equiv=["']?refresh["']?[^>]*>/gi, "");
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const ctrl = new BrowserController({ humanize: false });
    (ctrl as unknown as { page: Page }).page = page;
    return { ctrl, page };
  }

  // Details of one real <select> on the replayed page, read straight off the
  // DOM node (not the capture metadata) so drive-verification compares
  // against live truth.
  interface SelectDetails {
    disabled: boolean;
    value: string;
    options: Array<{ value: string; text: string }>;
  }

  async function readSelect(page: Page, selector: string): Promise<SelectDetails | null> {
    return page
      .locator(selector)
      .first()
      .evaluate((node) => {
        if (!(node instanceof HTMLSelectElement)) return null;
        return {
          disabled: node.disabled,
          value: node.value,
          options: Array.from(node.options).map((o) => ({
            value: o.value,
            text: o.textContent ?? "",
          })),
        };
      })
      .catch(() => null);
  }

  // The documented selectOption matcher contract: case-insensitive substring
  // match, FIRST matching option wins. Re-derived here independently so the
  // eval verifies the contract rather than the implementation against itself.
  function expectedValueForMatcher(details: SelectDetails, matcher: string): string | null {
    const needle = matcher.toLowerCase();
    const hit = details.options.find((o) => o.text.toLowerCase().includes(needle));
    return hit !== undefined ? hit.value : null;
  }

  // Walked native selects that are drivable on the replayed DOM.
  function walkedSelects(els: InteractiveElement[]): InteractiveElement[] {
    return els.filter((e) => e.tag === "select" && e.visible);
  }

  // KNOWN GAP #2 (surfaced by this eval's first run): when the walker's CSS
  // path is ambiguous it emits a Playwright-chain selector ("div > … > select
  // >> nth=1"). selectOption's native path composes `${selector} option` to
  // list options — that string matches NOTHING for a chained selector, so the
  // primitive throws "has no selectable option" even when the select is full.
  // Such selects are currently UNDRIVABLE by selectOption; the driving suites
  // skip + count them, and a pinned test below asserts the throw.
  function isNthChainSelector(selector: string): boolean {
    return selector.includes(" >> ");
  }

  it("census — corpus signal counts (also the per-run report)", () => {
    const telWithTrigger = telRecords.filter((r) => hasCountryCodeTrigger(r.html));
    const telWithDialSelect = telRecords.filter((r) => hasDialCodeSelect(r.html));
    console.log(
      [
        "[widget-corpus-eval] census:",
        `  files scanned:              ${scan.filesScanned} (raw scan ${(scan.scanMs / 1000).toFixed(1)}s)`,
        `  native <select> records:    ${scan.nativeSelectFiles.length} (with >=2 selects: ${scan.nativeSelectMultiFiles.length})`,
        `  input[type=tel] records:    ${scan.telInputFiles.length} (parsed OK: ${telRecords.length})`,
        `  combobox/listbox records:   ${scan.comboboxRoleFiles.length}`,
        `  phone-country signals (over tel records):`,
        `    custom country-code trigger: ${telWithTrigger.length} (services: ${[...new Set(telWithTrigger.map((r) => r.service))].join(", ") || "none"})`,
        `    native dial-code <select>:   ${telWithDialSelect.length}`,
      ].join("\n"),
    );
    expect(scan.filesScanned).toBeGreaterThan(0);
  });

  it(
    "native <select>: target detection (unique, injective selectors) + matcher-driven value set & verified",
    async () => {
      const sample = sampleEvenly(scan.nativeSelectFiles, MAX_RECORDS);
      const stats = {
        replayed: 0,
        selectsWalked: 0,
        ambiguousSelectors: 0,
        nthChainSelectors: 0,
        injectivityViolations: 0,
        driven: 0,
        emptySelectThrows: 0,
      };
      for (const file of sample) {
        const rec = loadRecord(file);
        if (rec === null) continue;
        const { ctrl, page } = await openRecord(rec);
        try {
          stats.replayed += 1;
          const els = await ctrl.extractInteractiveElements();
          const selects = walkedSelects(els);
          stats.selectsWalked += selects.length;

          // (a) locality/target detection: each walked select's selector must
          // resolve to exactly one node, and no two walked rows may resolve
          // to the SAME node (an aliasing walker row is precisely the "drives
          // the wrong same-text control" bug class).
          const unique: InteractiveElement[] = [];
          for (const [ix, s] of selects.entries()) {
            if (isNthChainSelector(s.selector)) {
              stats.nthChainSelectors += 1;
              continue; // undrivable by selectOption today — see KNOWN GAP #2
            }
            const count = await page.locator(s.selector).count();
            if (count !== 1) {
              stats.ambiguousSelectors += 1;
              continue;
            }
            const priorStamp = await page
              .locator(s.selector)
              .first()
              .evaluate((node, stamp) => {
                const prior = node.getAttribute("data-ts-eval-stamp");
                if (prior === null) node.setAttribute("data-ts-eval-stamp", stamp);
                return prior;
              }, String(ix));
            if (priorStamp !== null) {
              stats.injectivityViolations += 1;
              continue;
            }
            unique.push(s);
          }

          // (b) drive up to 2 selects per record with a matcher chosen to
          // move the value AWAY from both the current value and the
          // no-matcher default — proving the matcher (not a fallback) drove
          // the pick — then read the committed value back off the DOM node.
          let drivenHere = 0;
          for (const s of unique) {
            if (drivenHere >= 2) break;
            const details = await readSelect(page, s.selector);
            if (details === null || details.disabled) continue;
            if (details.options.length === 0) {
              // (c) loud failure: an option-less select must throw, never
              // report success.
              await expect(ctrl.selectOption(s.selector)).rejects.toThrow(
                /no selectable option/,
              );
              stats.emptySelectThrows += 1;
              continue;
            }
            const firstReal = details.options.find((o) => o.value.length > 0)?.value;
            const target = [...details.options]
              .reverse()
              .find(
                (o) =>
                  o.text.trim().length > 0 &&
                  o.value !== details.value &&
                  o.value !== firstReal,
              );
            if (target === undefined) continue; // nothing to move to — not a drivable case
            const matcher = target.text.trim();
            const expected = expectedValueForMatcher(details, matcher);
            if (expected === null) continue; // whitespace-mangled text — skip, not a contract case
            await ctrl.selectOption(s.selector, matcher);
            const after = await readSelect(page, s.selector);
            expect(after?.value, `${rec.service}: ${s.selector} matcher "${matcher}"`).toBe(
              expected,
            );
            // The committed-select marker consumed by inventory rendering.
            const touched = await page
              .locator(s.selector)
              .first()
              .evaluate((node) => node.getAttribute("data-ts-touched"));
            expect(touched).toBe("1");
            drivenHere += 1;
            stats.driven += 1;
          }
        } finally {
          await page.close();
        }
      }
      console.log(
        `[widget-corpus-eval] native-select suite: replayed ${stats.replayed} records, ` +
          `walked ${stats.selectsWalked} selects (ambiguous: ${stats.ambiguousSelectors}, ` +
          `nth-chain (undrivable, KNOWN GAP #2): ${stats.nthChainSelectors}), ` +
          `driven+verified ${stats.driven}, empty-select loud failures: ${stats.emptySelectThrows}`,
      );
      expect(stats.injectivityViolations).toBe(0);
      // The suite must have actually proven something.
      expect(stats.driven).toBeGreaterThan(0);
    },
    600_000,
  );

  it(
    "locality: driving one select never disturbs a sibling select",
    async () => {
      const sample = sampleEvenly(scan.nativeSelectMultiFiles, Math.min(6, MAX_RECORDS));
      let checked = 0;
      for (const file of sample) {
        const rec = loadRecord(file);
        if (rec === null) continue;
        const { ctrl, page } = await openRecord(rec);
        try {
          const els = await ctrl.extractInteractiveElements();
          const selects = walkedSelects(els);
          if (selects.length < 2) continue;
          const detailed: Array<{ el: InteractiveElement; details: SelectDetails }> = [];
          for (const s of selects) {
            if (isNthChainSelector(s.selector)) continue; // KNOWN GAP #2 — undrivable
            if ((await page.locator(s.selector).count()) !== 1) continue;
            const details = await readSelect(page, s.selector);
            if (details !== null && !details.disabled) detailed.push({ el: s, details });
          }
          if (detailed.length < 2) continue;
          // Drive the first select that HAS somewhere to move; assert every
          // OTHER select's committed value is untouched afterwards. This is
          // the static analogue of "phone-country intent must never land on
          // the address-country <select>".
          const driver = detailed.find((d) =>
            d.details.options.some((o) => o.text.trim().length > 0 && o.value !== d.details.value),
          );
          if (driver === undefined) continue;
          const target = [...driver.details.options]
            .reverse()
            .find((o) => o.text.trim().length > 0 && o.value !== driver.details.value);
          if (target === undefined) continue;
          const matcher = target.text.trim();
          const expected = expectedValueForMatcher(driver.details, matcher);
          if (expected === null) continue;
          const others = detailed.filter((d) => d !== driver);
          await ctrl.selectOption(driver.el.selector, matcher);
          const after = await readSelect(page, driver.el.selector);
          expect(after?.value, `${rec.service}: driven select committed`).toBe(expected);
          for (const other of others) {
            const otherAfter = await readSelect(page, other.el.selector);
            expect(
              otherAfter?.value,
              `${rec.service}: sibling ${other.el.selector} must be untouched`,
            ).toBe(other.details.value);
          }
          checked += 1;
        } finally {
          await page.close();
        }
      }
      console.log(`[widget-corpus-eval] locality suite: ${checked} multi-select records checked`);
      expect(checked).toBeGreaterThan(0);
    },
    300_000,
  );

  it(
    "phone-country signals: triggers are custom widgets, distinct from every native <select>",
    async () => {
      // setPhoneCountry isn't exported on main yet — this suite validates the
      // STATIC prerequisites any implementation of it depends on, and is the
      // wiring point for its eval once it lands.
      const candidates = telRecords.filter((r) => hasCountryCodeTrigger(r.html));
      if (candidates.length === 0) {
        console.log(
          "[widget-corpus-eval] phone suite: 0 corpus records with a country-code trigger — " +
            "nothing to replay. Grow coverage by capturing a live phone widget " +
            "(docs/WIDGET-CORPUS-EVAL.md, 'Adding captures').",
        );
        return;
      }
      const sample = sampleEvenly(candidates, Math.min(6, MAX_RECORDS));
      let replayed = 0;
      let triggersFound = 0;
      for (const rec of sample) {
        const { ctrl, page } = await openRecord(rec);
        try {
          const els = await ctrl.extractInteractiveElements();
          // The walker must surface both halves of the phone widget: the tel
          // input and the country-code trigger.
          const tel = els.find((e) => e.type === "tel");
          expect(tel, `${rec.service}: walker must surface the tel input`).toBeDefined();
          const triggers = els.filter(
            (e) =>
              e.tag !== "select" &&
              isDialCodeTriggerText([e.ariaLabel, e.visibleText, e.iconLabel, e.title]),
          );
          expect(
            triggers.length,
            `${rec.service}: walker must surface the country-code trigger`,
          ).toBeGreaterThan(0);
          triggersFound += triggers.length;
          for (const trigger of triggers) {
            // Target detection: the trigger's selector must resolve, and to a
            // NON-<select> node — i.e. a phone-country primitive that resolved
            // this trigger could never land on an unrelated native select
            // (address country, industry, timezone) as a "close enough" match.
            const tag = await page
              .locator(trigger.selector)
              .first()
              .evaluate((node) => node.tagName.toLowerCase());
            expect(tag, `${rec.service}: trigger ${trigger.selector}`).not.toBe("select");
          }
          // And the record's native selects genuinely are NOT dial-code
          // selects — so "fall back to driving a <select>" would be WRONG
          // here, which is exactly the ground truth a set_phone_country
          // review needed.
          for (const s of walkedSelects(els)) {
            const details = await readSelect(page, s.selector);
            if (details === null) continue;
            const dialish = details.options.filter((o) =>
              /\+\d{1,3}(?![\d:])/.test(o.text),
            ).length;
            expect(
              dialish,
              `${rec.service}: native select ${s.selector} must not be a dial-code select`,
            ).toBeLessThan(5);
          }
          replayed += 1;
        } finally {
          await page.close();
        }
      }
      console.log(
        `[widget-corpus-eval] phone suite: ${candidates.length} trigger records in corpus, ` +
          `${replayed} replayed, ${triggersFound} triggers verified non-<select>. ` +
          "(Static DOM cannot open the popover — dynamic commit is live-smoke territory.)",
      );
      expect(replayed).toBeGreaterThan(0);
    },
    300_000,
  );

  it(
    "loud failure: a selector that matches nothing throws (never a silent default)",
    async () => {
      const file = scan.nativeSelectFiles[0];
      expect(file).toBeDefined();
      const rec = file !== undefined ? loadRecord(file) : null;
      expect(rec).not.toBeNull();
      if (rec === null) return;
      const { ctrl, page } = await openRecord(rec);
      try {
        await expect(
          ctrl.selectOption("#ts-widget-eval-does-not-exist"),
        ).rejects.toThrow();
      } finally {
        await page.close();
      }
    },
    60_000,
  );

  it(
    "loud failure: a custom combobox that cannot open throws no-options (never false success)",
    async () => {
      // With JS disabled the popover can never render, so the ONLY correct
      // outcome is selectFromCombobox's "no options found after click" throw.
      // A resolved promise here would be a false success on every static
      // combobox — the worst silent-failure class this harness guards.
      // No optionMatcher is passed: the text-based tier 6 would otherwise
      // count any matching page text as a commit.
      //
      // Replay artifact to exclude first: some captures carry an ALREADY
      // rendered option list in the HTML (captured mid-open, or hidden only
      // by external CSS that the offline replay blocks). On those pages the
      // option tiers legitimately find visible options, so the throw contract
      // doesn't apply — skip them (counted below). Mirrors selectFromCombobox's
      // pattern tiers.
      const optionTierProbe =
        '[role="option"], [role="menuitem"], [role="menuitemradio"], mat-option, ' +
        '.mat-mdc-option, [id^="react-select-"][role*="menu"], [role="listbox"] li';
      const sample = sampleEvenly(scan.comboboxRoleFiles, 24);
      let attempted = 0;
      let staticallyOpenSkipped = 0;
      for (const file of sample) {
        if (attempted >= 2) break;
        const rec = loadRecord(file);
        if (rec === null) continue;
        const { ctrl, page } = await openRecord(rec);
        try {
          const visibleOptionNodes = await page
            .locator(optionTierProbe)
            .filter({ visible: true })
            .count();
          if (visibleOptionNodes > 0) {
            staticallyOpenSkipped += 1;
            continue;
          }
          const els = await ctrl.extractInteractiveElements();
          const trigger = els.find(
            (e) =>
              e.role === "combobox" &&
              e.tag !== "select" &&
              e.visible &&
              e.topmost !== false,
          );
          if (trigger === undefined) continue;
          await expect(
            ctrl.selectOption(trigger.selector),
            `${rec.service}: static combobox ${trigger.selector} must throw`,
          ).rejects.toThrow(/no options found|not|disabled/i);
          attempted += 1;
        } finally {
          await page.close();
        }
      }
      console.log(
        `[widget-corpus-eval] combobox loud-failure suite: ${attempted} records attempted, ` +
          `${staticallyOpenSkipped} skipped (option list already visible in the static capture)`,
      );
      expect(attempted).toBeGreaterThan(0);
    },
    300_000,
  );

  it(
    "KNOWN GAP: native-select matcher with NO matching option silently falls back to the first real option (desired: throw)",
    async () => {
      // This pins CURRENT behavior as executable ground truth: selectOption's
      // native path keeps the first-non-placeholder fallback when the matcher
      // matches nothing (browser.ts native path: `if (matched !== null)`), so
      // a planner typo picks a plausible-looking wrong option instead of
      // failing loudly. The desired contract per the widget review is a
      // throw. When selectOption gains loud no-match handling, THIS TEST MUST
      // FLIP to `rejects.toThrow` — its failure is the reminder.
      const sample = sampleEvenly(scan.nativeSelectFiles, MAX_RECORDS);
      for (const file of sample) {
        const rec = loadRecord(file);
        if (rec === null) continue;
        const { ctrl, page } = await openRecord(rec);
        try {
          const els = await ctrl.extractInteractiveElements();
          const s = walkedSelects(els).find((e) => e.selector.length > 0);
          if (s === undefined || (await page.locator(s.selector).count()) !== 1) continue;
          const details = await readSelect(page, s.selector);
          if (details === null || details.disabled || details.options.length === 0) continue;
          const firstReal =
            details.options.find((o) => o.value.length > 0)?.value ?? details.options[0]?.value;
          await ctrl.selectOption(s.selector, "zz-ts-widget-eval-no-such-option");
          const after = await readSelect(page, s.selector);
          expect(after?.value, `${rec.service}: silent fallback target`).toBe(firstReal);
          console.log(
            `[widget-corpus-eval] KNOWN GAP confirmed on ${rec.service}: ` +
              `no-match matcher fell back to value "${firstReal ?? ""}" without throwing`,
          );
          return; // one confirmation is the point
        } finally {
          await page.close();
        }
      }
      throw new Error("no drivable select found to demonstrate the known gap");
    },
    120_000,
  );

  it(
    "KNOWN GAP #2: a walker nth-chain selector makes selectOption throw 'no selectable option' on a FULL select",
    async () => {
      // Surfaced by this eval's first run. The walker pins ambiguous CSS
      // paths with Playwright chain syntax ("div > … > select >> nth=1");
      // selectOption's native path lists options by composing
      // `${selector} option`, which matches nothing for a chained selector —
      // so a select FULL of options reads as empty and the primitive throws
      // "has no selectable option". Every ambiguous-path native select in an
      // inventory is therefore undrivable today. This pins that behavior;
      // when selectOption composes chain selectors correctly (e.g.
      // `locator(sel).locator("option")`), flip this to assert the drive
      // SUCCEEDS and un-skip nth-chain selectors in the suites above.
      const candidates = [
        ...sampleEvenly(scan.nativeSelectMultiFiles, 12),
        ...sampleEvenly(scan.nativeSelectFiles, 12),
      ];
      for (const file of candidates) {
        const rec = loadRecord(file);
        if (rec === null) continue;
        const { ctrl, page } = await openRecord(rec);
        try {
          const els = await ctrl.extractInteractiveElements();
          for (const s of walkedSelects(els)) {
            if (!isNthChainSelector(s.selector)) continue;
            const details = await readSelect(page, s.selector);
            if (details === null || details.options.length === 0) continue;
            await expect(
              ctrl.selectOption(s.selector),
              `${rec.service}: ${s.selector} has ${details.options.length} options yet reads empty`,
            ).rejects.toThrow(/no selectable option/);
            console.log(
              `[widget-corpus-eval] KNOWN GAP #2 confirmed on ${rec.service}: ` +
                `"${s.selector}" carries ${details.options.length} options but selectOption threw`,
            );
            return;
          }
        } finally {
          await page.close();
        }
      }
      // Corpus-dependent: no ambiguous-path select in the sample. Not a
      // failure — but say so, since the gap then went unexercised this run.
      console.log(
        "[widget-corpus-eval] KNOWN GAP #2: no nth-chain select selector in this sample — gap not exercised",
      );
    },
    300_000,
  );
});
