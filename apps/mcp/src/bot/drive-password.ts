// Invented signup passwords for operate_drive. The page states what a new
// password must satisfy; this reads those requirements from its visible text
// and control attributes and generates a random value that meets them. The
// value is created here and handed only to the session's sealed slots and the
// vault — never to drive output, traces, or the model.
import { randomInt } from "node:crypto";

const LOWER = "abcdefghijkmnpqrstuvwxyz"; // no l/o
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O
const DIGIT = "23456789"; // no 0/1
const SYMBOL = "!@#$%^&*-_=+";

/** Comfortably above common minimums; the page's own limits override it. */
export const INVENTED_PASSWORD_DEFAULT_LENGTH = 24;
const INVENTED_PASSWORD_CEILING = 128;
const PATTERN_ATTEMPTS = 64;

export interface PasswordRequirements {
  minLength: number;
  maxLength?: number;
  /** Symbols the password may use; empty when the page forbids them. */
  symbols: string;
  /** The control's own `pattern`, when it is complete and compiles. */
  pattern?: RegExp;
}

const LENGTH_UNIT = "(?:characters?|chars?)";

function lengthNumbers(text: string, expressions: readonly RegExp[]): number[] {
  const found: number[] = [];
  for (const expression of expressions) {
    for (const match of text.matchAll(expression)) {
      const value = Number(match[1]);
      if (Number.isInteger(value) && value > 0 && value <= INVENTED_PASSWORD_CEILING) {
        found.push(value);
      }
    }
  }
  return found;
}

/** Symbols a page lists right after naming "special characters" / "symbols". */
function listedSymbols(text: string): string {
  const match =
    /(?:special\s+characters?|symbols?)[^\n(:]{0,20}[(:]\s*(?:e\.g\.,?\s*|such\s+as\s*|like\s*)?([^)\n]{1,40})/i.exec(
      text,
    );
  if (match === null) return "";
  const listed = new Set(match[1]!.replace(/[\sA-Za-z0-9,.]/g, ""));
  return [...SYMBOL].filter((symbol) => listed.has(symbol)).join("");
}

/**
 * Read a new-password field's requirements from the page. `text` is the
 * field's label plus the page's visible text; `maxLengthAttr` and `pattern`
 * are the control's own attributes.
 */
export function parsePasswordRequirements(
  text: string,
  maxLengthAttr?: number,
  pattern?: string,
): PasswordRequirements {
  const flat = text.replace(/\s+/g, " ");
  const minimums = lengthNumbers(flat, [
    new RegExp(
      `\\b(?:at\\s+least|min(?:imum)?(?:\\s+of)?|no\\s+(?:less|fewer)\\s+than)\\s*:?\\s*(\\d{1,3})\\s*${LENGTH_UNIT}`,
      "gi",
    ),
    new RegExp(`\\b(\\d{1,3})\\s*(?:\\+|or\\s+more)\\s*${LENGTH_UNIT}`, "gi"),
    new RegExp(
      `\\b(\\d{1,3})\\s*${LENGTH_UNIT}\\s*(?:min(?:imum)?|or\\s+(?:more|longer))\\b`,
      "gi",
    ),
    new RegExp(`\\bbetween\\s+(\\d{1,3})\\s*(?:and|-|to)\\s*\\d{1,3}\\s*${LENGTH_UNIT}`, "gi"),
    new RegExp(`\\b(\\d{1,3})\\s*(?:-|–|to)\\s*\\d{1,3}\\s*${LENGTH_UNIT}`, "gi"),
  ]);
  const maximums = lengthNumbers(flat, [
    new RegExp(
      `\\b(?:at\\s+most|max(?:imum)?(?:\\s+of)?|no\\s+more\\s+than|up\\s+to)\\s*:?\\s*(\\d{1,3})\\s*${LENGTH_UNIT}`,
      "gi",
    ),
    new RegExp(`\\bbetween\\s+\\d{1,3}\\s*(?:and|-|to)\\s*(\\d{1,3})\\s*${LENGTH_UNIT}`, "gi"),
    new RegExp(`\\b\\d{1,3}\\s*(?:-|–|to)\\s*(\\d{1,3})\\s*${LENGTH_UNIT}`, "gi"),
  ]);
  if (maxLengthAttr !== undefined && maxLengthAttr > 0) maximums.push(maxLengthAttr);
  const noSymbols =
    /\b(?:no|without|must\s+not\s+(?:contain|include|use))\s+(?:special\s+characters?|symbols?|punctuation)\b/i.test(
      flat,
    ) ||
    /\b(?:letters?\s+and\s+(?:numbers?|digits?)|alphanumeric(?:\s+characters?)?)\s+only\b/i.test(
      flat,
    ) ||
    /\bonly\s+(?:letters?\s+and\s+(?:numbers?|digits?)|alphanumeric)\b/i.test(flat);
  const listed = noSymbols ? "" : listedSymbols(flat);
  let compiled: RegExp | undefined;
  // The snapshot cuts a pattern at 40 characters; a cut pattern is not the
  // control's real rule, so it is not enforced.
  if (pattern !== undefined && pattern.length > 0 && pattern.length < 40) {
    try {
      compiled = new RegExp(`^(?:${pattern})$`, "v");
    } catch {
      compiled = undefined;
    }
  }
  return {
    minLength: minimums.length === 0 ? 0 : Math.max(...minimums),
    ...(maximums.length === 0 ? {} : { maxLength: Math.min(...maximums) }),
    symbols: noSymbols ? "" : listed.length > 0 ? listed : SYMBOL,
    ...(compiled === undefined ? {} : { pattern: compiled }),
  };
}

function generate(length: number, symbols: string): string {
  const classes = [LOWER, UPPER, DIGIT, ...(symbols.length > 0 ? [symbols] : [])];
  const all = classes.join("");
  const pick = (set: string): string => set[randomInt(set.length)]!;
  const chars = classes.map(pick);
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

/**
 * A random password meeting `requirements`: lower, upper, digit and (unless
 * forbidden) a symbol, at the default length or longer when the page asks.
 * Undefined when the page's limits cannot be met together.
 */
export function inventPassword(requirements: PasswordRequirements): string | undefined {
  const classCount = requirements.symbols.length > 0 ? 4 : 3;
  const ceiling = Math.min(
    requirements.maxLength ?? INVENTED_PASSWORD_CEILING,
    INVENTED_PASSWORD_CEILING,
  );
  const length = Math.min(
    Math.max(INVENTED_PASSWORD_DEFAULT_LENGTH, requirements.minLength, classCount),
    ceiling,
  );
  if (length < Math.max(requirements.minLength, classCount)) return undefined;
  for (let attempt = 0; attempt < PATTERN_ATTEMPTS; attempt += 1) {
    // A pattern may admit only letters and digits; alternate symbol-free
    // candidates so such a control can still be satisfied.
    const symbols = attempt % 2 === 0 ? requirements.symbols : "";
    const candidate = generate(length, symbols);
    if (requirements.pattern === undefined || requirements.pattern.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
