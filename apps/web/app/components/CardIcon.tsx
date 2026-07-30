import { brandMonogram, brandNetwork, type CardNetwork } from "../lib/wallet";

// The 28px tile at the head of a wallet row, mirroring the vault's service
// `.ic` tile. A recognized network shows its mark as a small inline SVG —
// self-contained geometry/text, no external fetches (CSP) — so a card row
// reads at a glance like a card, not a key. A named-but-unrecognized brand
// falls back to the mono monogram (the vault's lettermark language); an
// unknown/legacy card shows the generic card glyph.
export function CardIcon({ brand }: { brand: string | null }) {
  const network = brandNetwork(brand);
  if (network !== null) {
    return (
      <div className="ic" aria-hidden="true">
        <NetworkMark network={network} />
      </div>
    );
  }
  const monogram = brandMonogram(brand);
  return (
    <div className="ic" aria-hidden="true">
      {monogram !== null ? (
        <span className="lm">{monogram}</span>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
          <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
          <path d="M2.5 9.5h19" />
        </svg>
      )}
    </div>
  );
}

// Compact network marks in a 24x16 box, legible at the tile's 16px render.
// Wordmarks use the page font (no embedded font data); geometric marks use
// the network's own colors — the one place brand color is the content.
function NetworkMark({ network }: { network: CardNetwork }) {
  switch (network) {
    case "visa":
      return (
        <svg viewBox="0 0 24 16" data-network="visa" fill="none">
          <text
            x="12"
            y="11.5"
            textAnchor="middle"
            fontStyle="italic"
            fontWeight={700}
            fontSize="8.5"
            letterSpacing="0.4"
            fill="var(--fg)"
          >
            VISA
          </text>
        </svg>
      );
    case "mastercard":
      return (
        <svg viewBox="0 0 24 16" data-network="mastercard" fill="none">
          <circle cx="9.5" cy="8" r="5.5" fill="#EB001B" />
          <circle cx="14.5" cy="8" r="5.5" fill="#F79E1B" fillOpacity={0.85} />
        </svg>
      );
    case "amex":
      return (
        <svg viewBox="0 0 24 16" data-network="amex" fill="none">
          <rect x="1" y="1" width="22" height="14" rx="2" fill="#2E77BC" />
          <text
            x="12"
            y="10.6"
            textAnchor="middle"
            fontWeight={700}
            fontSize="5.5"
            letterSpacing="0.3"
            fill="#FFFFFF"
          >
            AMEX
          </text>
        </svg>
      );
    case "discover":
      return (
        <svg viewBox="0 0 24 16" data-network="discover" fill="none">
          <text x="4" y="11.5" fontWeight={700} fontSize="9" fill="var(--fg)">
            D
          </text>
          <circle cx="15.5" cy="8" r="4" fill="#F76B1C" />
        </svg>
      );
    case "diners":
      return (
        <svg viewBox="0 0 24 16" data-network="diners" fill="none">
          <circle cx="12" cy="8" r="6.5" fill="#0079BE" />
          <rect x="9.2" y="3.6" width="5.6" height="8.8" rx="2.8" fill="#FFFFFF" />
        </svg>
      );
    case "jcb":
      return (
        <svg viewBox="0 0 24 16" data-network="jcb" fill="none">
          <rect x="3.5" y="2" width="4.6" height="12" rx="2" fill="#0E4C96" />
          <rect x="9.7" y="2" width="4.6" height="12" rx="2" fill="#D9241C" />
          <rect x="15.9" y="2" width="4.6" height="12" rx="2" fill="#1B9C4E" />
        </svg>
      );
  }
}
