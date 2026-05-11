interface LogoProps {
  className?: string;
  title?: string;
}

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
        d="M 18 14 L 82 14 L 82 46 Q 82 70 50 88 Q 18 70 18 46 Z"
        fill="var(--color-mustard)"
        stroke="var(--color-wine)"
        strokeWidth="3.5"
        strokeLinejoin="round"
      />
      <path
        d="M 22 18 L 78 18 L 78 46 Q 78 67 50 83 Q 22 67 22 46 Z"
        fill="none"
        stroke="var(--color-wine)"
        strokeWidth="1"
        opacity="0.25"
      />
      <text
        x="50"
        y="56"
        fontFamily="var(--font-mono)"
        fontSize="32"
        fill="var(--color-wine)"
        fontWeight="700"
        textAnchor="middle"
      >
        {"{ }"}
      </text>
    </svg>
  );
}
