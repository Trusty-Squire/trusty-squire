import { brandMonogram } from "../lib/wallet";

// The 28px tile at the head of a wallet row, mirroring the vault's service
// `.ic` tile. A known brand shows a mono monogram (the vault's lettermark
// language); an unknown/legacy card shows a generic card glyph. No
// trademarked network logos — a monogram reads as intentional at 17px and
// carries no licensing risk.
export function CardIcon({ brand }: { brand: string | null }) {
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
