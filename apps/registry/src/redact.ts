const TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-or-v1-[a-f0-9]{40,80}/gi,
  /\bsk-ant-[a-zA-Z0-9_\-]{40,120}/g,
  /\bsk-proj-[a-zA-Z0-9_\-]{40,200}/g,
  /\bsk-[a-zA-Z0-9]{40,60}/g,
  /\bsk_(?:live|test)_[a-zA-Z0-9]{20,}/g,
  /\bre_[a-zA-Z0-9_]{20,}/g,
  /\bSG\.[a-zA-Z0-9_\-]{20,}\.[a-zA-Z0-9_\-]{20,}/g,
  /\bkey-[a-f0-9]{32}/g,
  /\bsntr[su]_[A-Za-z0-9_=\-]{20,}/g,
  /\brnd_[a-zA-Z0-9]{20,}/g,
  /\bpscale_tkn_[A-Za-z0-9]{30,}/gi,
  /\bsbp_[A-Za-z0-9]{30,}/gi,
  /\bnapi_[a-zA-Z0-9]{30,80}/g,
  /\br8_[a-zA-Z0-9]{30,60}/g,
  /\b[A-Za-z0-9]{6,12}\.[A-Za-z0-9]{30,50}\b/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\|[A-Za-z0-9_\-]{30,80}\b/gi,
  /\beyJ[A-Za-z0-9_\-]{20,}\.eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\b/g,
  /\btsm_[A-Za-z0-9]{30,}/g,
  /\bddp_[A-Za-z0-9]{30,}/g,
  /\bwhsec_[A-Za-z0-9+/=]{20,}/g,
  /\bcfut_[A-Za-z0-9]{40,}/g,
  /\bcfat_[A-Za-z0-9]{40,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
];

const HTML_SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /(\bname=["'](?:cf-turnstile-response|g-recaptcha-response|h-captcha-response)["'][^>]*\bvalue=["'])[^"']{16,}(["'])/gi,
    "$1REDACTED$2",
  ],
  [
    /(["']?(?:cf-turnstile-response|g-recaptcha-response|h-captcha-response)["']?\s*[:=]\s*["'])[^"']{16,}(["'])/gi,
    "$1REDACTED$2",
  ],
  [
    /(["']?(?:authorization|cookie|set-cookie|x-api-key|x-auth-token)["']?\s*[:=]\s*["'])[^"'\n]{12,}(["'])/gi,
    "$1REDACTED$2",
  ],
  [/(\bBearer\s+)[A-Za-z0-9._\-]{16,}/gi, "$1REDACTED"],
  [
    /(<input\b[^>]*\btype=["']password["'][^>]*\bvalue=["'])[^"']+(["'])/gi,
    "$1REDACTED$2",
  ],
  [
    /(<input\b[^>]*\bvalue=["'])[^"']+(["'][^>]*\btype=["']password["'])/gi,
    "$1REDACTED$2",
  ],
];

export function redactCredentials(text: string): string {
  let out = text;
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, (match) => {
      const sepIdx = Math.max(match.indexOf("_"), match.indexOf("-"));
      const prefix = sepIdx > 0 ? match.slice(0, sepIdx + 1) : match.slice(0, 3);
      const tail = match.slice(-6);
      return `${prefix}REDACTED...${tail}`;
    });
  }
  return out;
}

export function redactHtml(html: string): string {
  let out = redactCredentials(html);
  for (const [re, repl] of HTML_SECRET_PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}
