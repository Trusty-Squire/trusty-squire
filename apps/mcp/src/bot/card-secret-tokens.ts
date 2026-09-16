/**
 * Per-digit masked-secret tokens for a released payment card.
 *
 * After the single-human purchase approval releases a card, the agent never
 * sees the real PAN or CVV digits. Instead it references them as opaque
 * per-digit tokens it can place into ANY observation ref with the ordinary
 * acting verbs (operate_type), with any timing and per-field / per-digit
 * retry. The broker substitutes the real digit only at the keystroke
 * boundary — inside act(), after the target element is resolved and before
 * the write reaches the page — and the substituted value is never returned
 * to the agent: action results echo no typed text, and every observation,
 * screenshot, and evidence read passes through the session's
 * CardValueOutputMask, which is registered at release time, before the
 * tokens even exist for the agent.
 *
 * Expiry, cardholder name, and billing are NOT secret and are not tokenized;
 * the agent fills them with ordinary operate_type/operate_select values.
 */

export const CARD_TOKEN_PAN = "{{pan}}";
export const CARD_TOKEN_CVV = "{{cvv}}";
/** Per-digit spelling: {{pan:5}} is the PAN's 5th digit, {{cvv:2}} the CVV's 2nd. */
export const CARD_TOKEN_PAN_DIGIT = "{{pan:N}}";
export const CARD_TOKEN_CVV_DIGIT = "{{cvv:N}}";

const PAN_TOKEN_SOURCE = /\{\{\s*pan\s*(?::\s*(\d{1,2})\s*)?\}\}/g;
const CVV_TOKEN_SOURCE = /\{\{\s*cvv\s*(?::\s*(\d{1,2})\s*)?\}\}/g;

export interface CardTokenVocabulary {
  pan: string;
  pan_digit: string;
  cvv: string;
  cvv_digit: string;
  pan_length: number;
  cvv_length: number;
}

function substituteOne(
  text: string,
  source: RegExp,
  value: string,
  kind: "pan" | "cvv",
): string {
  return text.replace(source, (token, indexRaw: string | undefined) => {
    if (indexRaw === undefined) return value;
    const index = Number(indexRaw);
    if (!Number.isInteger(index) || index < 1 || index > value.length) {
      throw new Error(
        `card token ${token} is out of range: ${kind} has ${value.length} digits (1-${value.length})`,
      );
    }
    return value[index - 1]!;
  });
}

/**
 * Replace card tokens in agent-authored text with the real digits. Called
 * ONLY inside the broker's dispatch boundary: the returned string goes
 * straight to the page's keystroke/fill path and must never be echoed into
 * a tool result, log, or observation (the action path already guarantees
 * this — type results carry no typed text — and the output mask covers the
 * page's own re-renders of the value).
 */
export function substituteCardTokens(
  card: { pan: string; cvv: string },
  text: string,
): string {
  let out = substituteOne(text, PAN_TOKEN_SOURCE, card.pan, "pan");
  out = substituteOne(out, CVV_TOKEN_SOURCE, card.cvv, "cvv");
  return out;
}

/** True when the text references a card token at all. */
export function referencesCardToken(text: string): boolean {
  PAN_TOKEN_SOURCE.lastIndex = 0;
  CVV_TOKEN_SOURCE.lastIndex = 0;
  return PAN_TOKEN_SOURCE.test(text) || CVV_TOKEN_SOURCE.test(text);
}

/**
 * The token names an agent places into refs. Carries lengths (public
 * metadata) but never a digit of the real values.
 */
export function cardTokenVocabulary(card: {
  pan: string;
  cvv: string;
}): CardTokenVocabulary {
  const panDigits = card.pan.replace(/\D/g, "");
  const cvvDigits = card.cvv.replace(/\D/g, "");
  return {
    pan: CARD_TOKEN_PAN,
    pan_digit: CARD_TOKEN_PAN_DIGIT,
    cvv: CARD_TOKEN_CVV,
    cvv_digit: CARD_TOKEN_CVV_DIGIT,
    pan_length: panDigits.length,
    cvv_length: cvvDigits.length,
  };
}
