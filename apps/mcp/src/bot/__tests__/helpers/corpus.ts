// Corpus loader/classifier for the widget-driving eval
// (widget-corpus-eval.test.ts). Reads the REAL captured onboarding corpus
// (~/.trusty-squire/corpus/onboarding by default — full page HTML + walked
// element inventory per record) so widget primitives can be evaluated against
// real-world DOM shapes instead of reviewer-vs-fixer hypotheses.
//
// Kept inside __tests__/ deliberately: this is test scaffolding, not product
// code. The corpus itself is NOT in the repo — everything here must degrade
// gracefully (return null / empty) when the directory is absent so CI without
// the corpus stays green.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ───────────── corpus location ─────────────

// Resolve the corpus directory: TRUSTY_SQUIRE_CORPUS_DIR wins ("0" / "off" /
// "false" disables the eval outright — the escape hatch for a dev box where
// the 4.5GB scan is unwanted), else the default capture location. Returns
// null when disabled or the directory doesn't exist — callers must skip.
export function resolveCorpusDir(): string | null {
  const raw = process.env.TRUSTY_SQUIRE_CORPUS_DIR;
  if (raw !== undefined) {
    const trimmed = raw.trim();
    if (trimmed === "" || ["0", "off", "false"].includes(trimmed.toLowerCase())) {
      return null;
    }
    return fs.existsSync(trimmed) ? trimmed : null;
  }
  const fallback = path.join(os.homedir(), ".trusty-squire", "corpus", "onboarding");
  return fs.existsSync(fallback) ? fallback : null;
}

// ───────────── raw signal scan (census) ─────────────

// Byte-level probes over the raw capture JSON. The corpus is ~4.5GB across
// ~15k files, so the full-corpus census avoids JSON.parse entirely: captures
// are written with JSON.stringify(…, null, 2), but both spacing variants are
// probed in case the writer ever changes. Buffer.includes is memchr-fast;
// this pass is I/O-bound, not CPU-bound.
const PROBES = {
  nativeSelect: ['"tag": "select"', '"tag":"select"'],
  telInput: ['"type": "tel"', '"type":"tel"'],
  comboboxRole: ['"role": "combobox"', '"role":"combobox"', '"role": "listbox"', '"role":"listbox"'],
} as const;

export interface RawSignals {
  nativeSelect: boolean;
  // ≥2 native-select inventory rows — the locality-suite material (drive one
  // select, assert the OTHER is untouched).
  nativeSelectMulti: boolean;
  telInput: boolean;
  comboboxRole: boolean;
}

function countOccurrences(buf: Buffer, needle: string, cap: number): number {
  let count = 0;
  let at = buf.indexOf(needle);
  while (at !== -1 && count < cap) {
    count += 1;
    at = buf.indexOf(needle, at + needle.length);
  }
  return count;
}

export function probeBuffer(buf: Buffer): RawSignals {
  const selectHits =
    countOccurrences(buf, PROBES.nativeSelect[0], 2) + countOccurrences(buf, PROBES.nativeSelect[1], 2);
  return {
    nativeSelect: selectHits >= 1,
    nativeSelectMulti: selectHits >= 2,
    telInput: PROBES.telInput.some((p) => buf.includes(p)),
    comboboxRole: PROBES.comboboxRole.some((p) => buf.includes(p)),
  };
}

export interface CorpusScan {
  filesScanned: number;
  scanMs: number;
  nativeSelectFiles: string[];
  nativeSelectMultiFiles: string[];
  telInputFiles: string[];
  comboboxRoleFiles: string[];
}

// Full-corpus census. Reads every *.json once; returns the file lists per
// signal so suites sample from them. Sorted input keeps the census (and the
// deterministic sampling below) stable across runs.
export function scanCorpus(dir: string): CorpusScan {
  const start = Date.now();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(dir, f));
  const scan: CorpusScan = {
    filesScanned: 0,
    scanMs: 0,
    nativeSelectFiles: [],
    nativeSelectMultiFiles: [],
    telInputFiles: [],
    comboboxRoleFiles: [],
  };
  for (const file of files) {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch {
      continue; // a file deleted mid-scan is not this eval's problem
    }
    scan.filesScanned += 1;
    const sig = probeBuffer(buf);
    if (sig.nativeSelect) scan.nativeSelectFiles.push(file);
    if (sig.nativeSelectMulti) scan.nativeSelectMultiFiles.push(file);
    if (sig.telInput) scan.telInputFiles.push(file);
    if (sig.comboboxRole) scan.comboboxRoleFiles.push(file);
  }
  scan.scanMs = Date.now() - start;
  return scan;
}

// ───────────── record loading ─────────────

// Minimal view of a capture record — only what the eval consumes. The full
// capture carries screenshot/observed/hash fields this harness never reads.
export interface CorpusRecord {
  file: string;
  service: string;
  url: string;
  html: string;
}

function isObject(u: unknown): u is Record<string, unknown> {
  return typeof u === "object" && u !== null;
}

// Parse + narrow one capture. Returns null on malformed JSON / shape — a
// single corrupt capture must not kill the whole eval.
export function loadRecord(file: string): CorpusRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const state = parsed.state;
  if (!isObject(state)) return null;
  const html = state.html;
  const url = state.url;
  if (typeof html !== "string" || html.length === 0) return null;
  return {
    file,
    service: typeof parsed.service === "string" ? parsed.service : "unknown",
    url: typeof url === "string" ? url : "",
    html,
  };
}

// ───────────── phone / dial-code classification ─────────────

// A native <select> whose options carry dial codes ("+1", "United States
// (+44)"). The negative lookahead rejects timezone-offset options like
// "London (GMT) [+01:00]" — kinde's timezone picker false-positived a naive
// "+NN" probe. Real dial-code selects list ~150+ countries, so require
// several distinct option hits before classifying.
const DIAL_OPTION_RE = /<option\b[^>]*>[^<]*\+\d{1,3}(?![\d:])/g;

export function hasDialCodeSelect(html: string): boolean {
  DIAL_OPTION_RE.lastIndex = 0;
  let hits = 0;
  while (DIAL_OPTION_RE.exec(html) !== null) {
    hits += 1;
    if (hits >= 5) return true;
  }
  return false;
}

// A custom (non-<select>) phone-country trigger in the HTML: an element
// advertising "country code" (browserbase's Base UI popover button:
// aria-label="Country code" … <span>🇺🇸</span><span>+1</span>). This is the
// widget class a future setPhoneCountry must target — census + target
// detection only; a static DOM cannot open its popover (see the honest-scope
// note in widget-corpus-eval.test.ts).
const COUNTRY_TRIGGER_HTML_RE = /aria-label="[^"]*country[^"]*code[^"]*"/i;

export function hasCountryCodeTrigger(html: string): boolean {
  return COUNTRY_TRIGGER_HTML_RE.test(html);
}

// Dial-code trigger classification over WALKED elements (the live walker's
// output on the replayed DOM). Strong signal: an explicit country-code
// aria-label. Weak signal: a short label that IS a dial code ("🇺🇸 +1") —
// length-capped so free text mentioning "+1" doesn't qualify.
export function isDialCodeTriggerText(parts: ReadonlyArray<string | null | undefined>): boolean {
  const text = parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
  if (/country\s*code/i.test(text)) return true;
  return text.length <= 40 && /\+\d{1,3}(?![\d:])/.test(text);
}

// ───────────── deterministic sampling ─────────────

// Evenly-strided sample: stable across runs (input is sorted) and spread
// across the alphabet so one over-captured service (200 browserbase rounds)
// can't monopolize the sample the way "first N" would.
export function sampleEvenly<T>(items: readonly T[], cap: number): T[] {
  if (cap <= 0 || items.length === 0) return [];
  if (items.length <= cap) return [...items];
  const out: T[] = [];
  const stride = items.length / cap;
  for (let i = 0; i < cap; i += 1) {
    const item = items[Math.floor(i * stride)];
    if (item !== undefined) out.push(item);
  }
  return out;
}

export function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
