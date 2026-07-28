// Widget-driving eval over the REAL captured onboarding corpus.
//
// Why this exists: reviews of widget-driving operate_act kinds (select /
// set_phone_country) kept looping on HYPOTHESES about widget DOM shapes with
// no executable ground truth. The corpus (~15k captures, each carrying the
// full page HTML + the walked element inventory) IS that ground truth: this
// eval replays real captured DOMs in Chromium and runs the real primitives
// (BrowserController.extractInteractiveElements + selectOption +
// setPhoneCountry) against them.
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
//   (c) loud-failure contracts — a missing target, a matcher with no native
//       option match, or an unsupported custom widget must THROW, never
//       report false success.
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
//   WIDGET_EVAL_MAX_RECORDS    per-suite replay cap (default 12)
//
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
  sampleValidEvenly,
  parsePositiveInt,
  type CorpusScan,
  type CorpusRecord,
} from "./helpers/corpus.js";

const corpusDir = resolveCorpusDir();
const MAX_RECORDS = parsePositiveInt(process.env.WIDGET_EVAL_MAX_RECORDS) ?? 12;

it("valid replay sampling backfills without exceeding the cap", () => {
  const sample = sampleValidEvenly(
    ["bad-a", "good-a", "bad-b", "good-b", "good-c", "good-d"],
    2,
    (value) => (value.startsWith("good") ? value : null),
  );
  expect(sample.records).toEqual(["good-b", "good-a"]);
  expect(sample.records).toHaveLength(2);
  expect(sample.skippedInvalid).toBe(1);
  expect(
    sampleValidEvenly(["bad", "good-a", "good-b"], 1, (value) =>
      value.startsWith("good") ? value : null,
    ).records,
  ).toEqual(["good-a"]);
});

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
    console.log(`[widget-corpus-eval] corpus: ${corpusDir} (cap ${MAX_RECORDS}/suite)`);
  }
  expect(true).toBe(true);
});

describe.skipIf(corpusDir === null)("widget corpus eval (real captured DOMs)", () => {
  let browser: Browser;
  let context: BrowserContext;
  let scan: CorpusScan;
  let telRecords: CorpusRecord[] = [];
  let invalidTelRecords = 0;

  beforeAll(async () => {
    if (corpusDir === null) return;
    scan = scanCorpus(corpusDir);
    const loadedTelRecords = sampleValidEvenly(
      scan.telInputFiles,
      scan.telInputFiles.length,
      loadRecord,
    );
    telRecords = loadedTelRecords.records;
    invalidTelRecords = loadedTelRecords.skippedInvalid;
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

  interface PhoneSelectDetails extends SelectDetails {
    selector: string;
    phoneNamed: boolean;
    telDistance: number;
  }

  async function readPhoneSelects(page: Page): Promise<PhoneSelectDetails[]> {
    return page.locator("select").evaluateAll((nodes) => {
      const out: PhoneSelectDetails[] = [];
      nodes.forEach((node, marker) => {
        if (!(node instanceof HTMLSelectElement)) return;
        const hay = `${node.className} ${node.getAttribute("name") ?? ""} ${node.id}`.toLowerCase();
        const phoneNamed = /phone|dial|calling/.test(hay);
        const isTel = (el: Element | null): boolean => el?.matches('input[type="tel"]') === true;
        let telDistance = Number.POSITIVE_INFINITY;
        const parent = node.parentElement;
        if (
          parent !== null &&
          parent.tagName !== "FORM" &&
          (isTel(node.previousElementSibling) || isTel(node.nextElementSibling))
        ) {
          telDistance = 0;
        } else if (
          parent !== null &&
          parent.tagName !== "FORM" &&
          Array.from(parent.children).some(isTel)
        ) {
          telDistance = 1;
        }
        const options = Array.from(node.options).map((option) => ({
          value: option.value,
          text: (option.textContent ?? "").replace(/\s+/g, " ").trim(),
        }));
        const isoish = options.filter((option) => /^[A-Za-z]{2}$/.test(option.value)).length;
        const dialish = options.filter(
          (option) => /\+\d/.test(option.text) || /^\+?\d{1,4}$/.test(option.value),
        ).length;
        const explicitDialish = options.filter(
          (option) => /\+\d/.test(option.text) || /^\+\d{1,4}$/.test(option.value),
        ).length;
        const countryish = options.length >= 10 && (isoish >= 5 || dialish >= 5);
        const countryNamed = /country|nation|iso/.test(hay);
        const dialCodeNamed = /dial|calling/.test(hay);
        const phoneCountryish =
          countryish ||
          explicitDialish > 0 ||
          (dialCodeNamed && dialish >= 2) ||
          (countryNamed && isoish >= 2);
        if (!((phoneNamed && phoneCountryish) || (countryish && telDistance <= 1))) return;
        node.setAttribute("data-ts-eval-phone-select", String(marker));
        out.push({
          selector: `select[data-ts-eval-phone-select="${marker}"]`,
          disabled: node.disabled,
          value: node.value,
          options,
          phoneNamed,
          telDistance: telDistance === Number.POSITIVE_INFINITY ? 99 : telDistance,
        });
      });
      return out;
    });
  }

  function phoneCountryTarget(
    details: SelectDetails,
  ): { query: string; expectedValue: string } | null {
    const iso2 = details.options.find(
      (option) => /^[A-Za-z]{2}$/.test(option.value) && option.value !== details.value,
    );
    if (iso2 !== undefined) {
      return { query: iso2.value.toUpperCase(), expectedValue: iso2.value };
    }
    for (const option of details.options) {
      const dialCode = option.text.match(/\+(\d{1,4})/)?.[1];
      if (dialCode === undefined) continue;
      const expected = details.options.find(
        (candidate) => candidate.text.match(/\+(\d{1,4})/)?.[1] === dialCode,
      );
      if (expected !== undefined && expected.value !== details.value) {
        return { query: `+${dialCode}`, expectedValue: expected.value };
      }
    }
    for (const option of details.options) {
      const query = option.text.trim();
      if (query.length <= 2 || option.value === details.value) continue;
      const expected = details.options.find((candidate) =>
        candidate.text.toLowerCase().includes(query.toLowerCase()),
      );
      if (expected !== undefined) return { query, expectedValue: expected.value };
    }
    return null;
  }

  async function drivePhoneSelect(
    ctrl: BrowserController,
    page: Page,
    rec: CorpusRecord,
    phoneSelects: PhoneSelectDetails[],
  ): Promise<void> {
    phoneSelects.sort(
      (a, b) => Number(b.phoneNamed) - Number(a.phoneNamed) || a.telDistance - b.telDistance,
    );
    const phoneSelect = phoneSelects[0];
    expect(phoneSelect, `${rec.service}: supported phone select must resolve`).toBeDefined();
    if (phoneSelect === undefined) return;
    const target = phoneCountryTarget(phoneSelect);
    expect(target, `${rec.service}: supported phone select must offer another country`).not.toBeNull();
    if (target === null) return;
    await ctrl.setPhoneCountry(target.query);
    expect(
      await page.locator(phoneSelect.selector).inputValue(),
      `${rec.service}: setPhoneCountry(${target.query})`,
    ).toBe(target.expectedValue);
  }

  function sampleRecords(files: readonly string[], cap: number) {
    return sampleValidEvenly(files, cap, loadRecord);
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
        `  input[type=tel] records:    ${scan.telInputFiles.length} (parsed OK: ${telRecords.length}, skipped invalid: ${invalidTelRecords})`,
        `  combobox/listbox records:   ${scan.comboboxRoleFiles.length}`,
        `  phone-country signals (over tel records):`,
        `    custom country-code trigger: ${telWithTrigger.length} (services: ${[...new Set(telWithTrigger.map((r) => r.service))].join(", ") || "none"})`,
        `    native dial-code <select>:   ${telWithDialSelect.length}`,
      ].join("\n"),
    );
    expect(scan.filesScanned).toBeGreaterThan(0);
  });

  it("native <select>: target detection (unique, injective selectors) + matcher-driven value set & verified", async () => {
    const sample = sampleRecords(scan.nativeSelectFiles, MAX_RECORDS);
    const stats = {
      replayed: 0,
      selectsWalked: 0,
      ambiguousSelectors: 0,
      nthChainSelectors: 0,
      injectivityViolations: 0,
      driven: 0,
      emptySelectThrows: 0,
    };
    for (const rec of sample.records) {
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
            await expect(ctrl.selectOption(s.selector)).rejects.toThrow(/no selectable option/);
            stats.emptySelectThrows += 1;
            continue;
          }
          const firstReal = details.options.find((o) => o.value.length > 0)?.value;
          const target = [...details.options]
            .reverse()
            .find(
              (o) => o.text.trim().length > 0 && o.value !== details.value && o.value !== firstReal,
            );
          if (target === undefined) continue; // nothing to move to — not a drivable case
          const matcher = target.text.trim();
          const expected = expectedValueForMatcher(details, matcher);
          if (expected === null) continue; // whitespace-mangled text — skip, not a contract case
          await ctrl.selectOption(s.selector, matcher);
          const after = await readSelect(page, s.selector);
          expect(after?.value, `${rec.service}: ${s.selector} matcher "${matcher}"`).toBe(expected);
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
        `driven+verified ${stats.driven}, empty-select loud failures: ${stats.emptySelectThrows}, ` +
        `skipped invalid: ${sample.skippedInvalid}`,
    );
    expect(stats.ambiguousSelectors).toBe(0);
    expect(stats.injectivityViolations).toBe(0);
    // The suite must have actually proven something.
    expect(stats.driven).toBeGreaterThan(0);
  }, 600_000);

  it("locality: driving one select never disturbs a sibling select", async () => {
    const sample = sampleRecords(scan.nativeSelectMultiFiles, Math.min(6, MAX_RECORDS));
    let checked = 0;
    let ambiguousSelectors = 0;
    for (const rec of sample.records) {
      const { ctrl, page } = await openRecord(rec);
      try {
        const els = await ctrl.extractInteractiveElements();
        const selects = walkedSelects(els);
        if (selects.length < 2) continue;
        const detailed: Array<{ el: InteractiveElement; details: SelectDetails }> = [];
        for (const s of selects) {
          if (isNthChainSelector(s.selector)) continue; // KNOWN GAP #2 — undrivable
          if ((await page.locator(s.selector).count()) !== 1) {
            ambiguousSelectors += 1;
            continue;
          }
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
    console.log(
      `[widget-corpus-eval] locality suite: ${checked} multi-select records checked, ` +
        `${ambiguousSelectors} ambiguous selectors, ${sample.skippedInvalid} skipped invalid`,
    );
    expect(ambiguousSelectors).toBe(0);
    expect(checked).toBeGreaterThan(0);
  }, 300_000);

  it("phone-country routing drives an ISO2 native select without dial-code text", async () => {
    const rec: CorpusRecord = {
      file: "iso2-phone-select",
      service: "iso2-phone-select",
      url: "https://example.invalid/signup",
      html:
        '<div><select class="PhoneInputCountrySelect">' +
        '<option value="US">United States</option>' +
        '<option value="JP">Japan</option>' +
        '<option value="KR">South Korea</option>' +
        '</select><input type="tel"></div>',
    };
    const { ctrl, page } = await openRecord(rec);
    try {
      const phoneSelects = await readPhoneSelects(page);
      expect(phoneSelects).toHaveLength(1);
      await drivePhoneSelect(ctrl, page, rec, phoneSelects);
      expect(await page.locator("select").inputValue()).toBe("JP");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("phone-country native selects: setPhoneCountry drives and verifies the real target", async () => {
    const candidates = telRecords;
    if (candidates.length === 0) {
      console.log("[widget-corpus-eval] native phone suite: 0 tel records");
      return;
    }
    const sample = sampleEvenly(candidates, MAX_RECORDS);
    let supported = 0;
    let driven = 0;
    for (const rec of sample) {
      const { ctrl, page } = await openRecord(rec);
      try {
        const phoneSelects = await readPhoneSelects(page);
        if (phoneSelects.length === 0) continue;
        supported += 1;
        await drivePhoneSelect(ctrl, page, rec, phoneSelects);
        driven += 1;
      } finally {
        await page.close();
      }
    }
    console.log(
      `[widget-corpus-eval] native phone suite: ${candidates.length} tel records in corpus, ` +
        `${sample.length} replayed, ${supported} supported, ${driven} driven+verified`,
    );
    expect(driven).toBe(supported);
  }, 300_000);

  it("phone-country custom triggers: target locality and unsupported-widget refusal", async () => {
    const candidates = telRecords.filter((record) => hasCountryCodeTrigger(record.html));
    if (candidates.length === 0) {
      console.log(
        "[widget-corpus-eval] phone suite: 0 corpus records with a country-code trigger — " +
          "nothing to replay. Grow coverage by capturing a live phone widget " +
          "(docs/WIDGET-CORPUS-EVAL.md, 'Adding captures').",
      );
      return;
    }
    const sample = sampleEvenly(candidates, MAX_RECORDS);
    let replayed = 0;
    let triggersFound = 0;
    let supportedDriven = 0;
    let unsupportedRefusals = 0;
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
          const triggerLocator = page.locator(trigger.selector);
          expect(
            await triggerLocator.count(),
            `${rec.service}: trigger ${trigger.selector} must resolve uniquely`,
          ).toBe(1);
          const tag = await triggerLocator.first().evaluate((node) => node.tagName.toLowerCase());
          expect(tag, `${rec.service}: trigger ${trigger.selector}`).not.toBe("select");
        }
        const phoneSelects = await readPhoneSelects(page);
        if (phoneSelects.length > 0) {
          await drivePhoneSelect(ctrl, page, rec, phoneSelects);
          supportedDriven += 1;
        } else {
          await expect(ctrl.setPhoneCountry("Japan")).rejects.toThrow(
            /this widget family is not supported yet/i,
          );
          unsupportedRefusals += 1;
        }
        replayed += 1;
      } finally {
        await page.close();
      }
    }
    console.log(
      `[widget-corpus-eval] phone suite: ${candidates.length} trigger records in corpus, ` +
        `${replayed} replayed, ${triggersFound} triggers verified non-<select>, ` +
        `${supportedDriven} supported native targets driven, ` +
        `${unsupportedRefusals} unsupported-widget refusals verified. ` +
        "(Static DOM cannot open the popover — dynamic commit is live-smoke territory.)",
    );
    expect(replayed).toBeGreaterThan(0);
  }, 300_000);

  it("loud failure: a selector that matches nothing throws (never a silent default)", async () => {
    const sample = sampleRecords(scan.nativeSelectFiles, 1);
    const rec = sample.records[0];
    expect(rec).toBeDefined();
    if (rec === undefined) return;
    const { ctrl, page } = await openRecord(rec);
    try {
      await expect(ctrl.selectOption("#ts-widget-eval-does-not-exist")).rejects.toThrow();
    } finally {
      await page.close();
    }
  }, 60_000);

  it("loud failure: a custom combobox that cannot open throws no-options (never false success)", async () => {
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
    const sample = sampleRecords(scan.comboboxRoleFiles, MAX_RECORDS);
    let attempted = 0;
    let staticallyOpenSkipped = 0;
    for (const rec of sample.records) {
      if (attempted >= 2) break;
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
          (e) => e.role === "combobox" && e.tag !== "select" && e.visible && e.topmost !== false,
        );
        if (trigger === undefined) continue;
        expect(
          await page.locator(trigger.selector).count(),
          `${rec.service}: combobox ${trigger.selector} must resolve uniquely`,
        ).toBe(1);
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
        `${staticallyOpenSkipped} skipped (option list already visible in the static capture), ` +
        `${sample.skippedInvalid} skipped invalid`,
    );
    if (attempted === 0 && sample.records.length < scan.comboboxRoleFiles.length) {
      console.log(
        "[widget-corpus-eval] combobox loud-failure suite: no applicable trigger within the capped sample — contract not exercised",
      );
    } else {
      expect(attempted).toBeGreaterThan(0);
    }
  }, 300_000);

  it("fixed contract: native-select matcher with no matching option throws", async () => {
    const sample = sampleRecords(scan.nativeSelectFiles, MAX_RECORDS);
    for (const rec of sample.records) {
      const { ctrl, page } = await openRecord(rec);
      try {
        const els = await ctrl.extractInteractiveElements();
        let s: InteractiveElement | undefined;
        for (const candidate of walkedSelects(els)) {
          if (
            candidate.selector.length > 0 &&
            !isNthChainSelector(candidate.selector) &&
            (await page.locator(candidate.selector).count()) === 1
          ) {
            s = candidate;
            break;
          }
        }
        if (s === undefined) continue;
        const details = await readSelect(page, s.selector);
        if (details === null || details.disabled || details.options.length === 0) continue;
        await expect(
          ctrl.selectOption(s.selector, "zz-ts-widget-eval-no-such-option"),
        ).rejects.toThrow(/no option matched/i);
        const after = await readSelect(page, s.selector);
        expect(after?.value, `${rec.service}: no-match must not change the select`).toBe(
          details.value,
        );
        console.log(`[widget-corpus-eval] fixed no-match contract verified on ${rec.service}`);
        return;
      } finally {
        await page.close();
      }
    }
    throw new Error("no non-nth-chain drivable select found to verify the no-match contract");
  }, 120_000);

  it("KNOWN GAP #2: a walker nth-chain selector makes selectOption throw 'no selectable option' on a FULL select", async () => {
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
    const candidateFiles = [
      ...new Set([...scan.nativeSelectMultiFiles, ...scan.nativeSelectFiles]),
    ];
    const candidates = sampleRecords(candidateFiles, MAX_RECORDS);
    for (const rec of candidates.records) {
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
  }, 300_000);
});
