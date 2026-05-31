// Shared brand mark. The shield outline inherits the current text color
// (`currentColor`) so it adapts to context — full-strength --fg in the
// nav/hero, muted in the footer — without per-call color props. The
// optional `{ }` glyph carries the one indigo accent.
//
// `size` is optional: pass it for inline sizing (hero, nav), omit it to
// let CSS size the SVG (e.g. `.auth-card .mark svg`). Pure presentational
// — safe to render from server or client components.

export function Shield({
  size,
  glyph = false,
  className,
}: {
  size?: number;
  glyph?: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
      className={className}
      style={size ? { width: size, height: size } : undefined}
    >
      <path
        d="M18 16 H82 V48 Q82 72 50 88 Q18 72 18 48 Z"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinejoin="round"
      />
      {glyph && (
        <text
          x="50"
          y="60"
          fontFamily="monospace"
          fontSize="30"
          fontWeight="700"
          textAnchor="middle"
          style={{ fill: "var(--accent)" }}
        >
          {"{ }"}
        </text>
      )}
    </svg>
  );
}
