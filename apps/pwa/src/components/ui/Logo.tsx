interface LogoProps {
  className?: string;
  title?: string;
}

// A minimal monochrome shield — the medieval hint, rendered in the
// Linear/Obsidian idiom: a single-weight outline, no fill, no
// ornament. The `{ }` glyph (the developer-identity tie-in) is the one
// spot of accent. Two colors, both from the theme tokens.
export function Logo({ className, title = "Trusty Squire" }: LogoProps) {
  return (
    <svg
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <path
        d="M 18 16 L 82 16 L 82 48 Q 82 72 50 88 Q 18 72 18 48 Z"
        fill="none"
        stroke="var(--color-text)"
        strokeWidth="5.5"
        strokeLinejoin="round"
      />
      <text
        x="50"
        y="58"
        fontFamily="var(--font-mono)"
        fontSize="30"
        fill="var(--color-accent)"
        fontWeight="700"
        textAnchor="middle"
      >
        {"{ }"}
      </text>
    </svg>
  );
}
