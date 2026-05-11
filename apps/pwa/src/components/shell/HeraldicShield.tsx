// Small subtle shield element pinned to the dashboard corner.
// Decorative; not interactive.

export function HeraldicShield() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed bottom-6 right-6 opacity-15 hover:opacity-30 transition-opacity"
    >
      <svg width="48" height="48" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M 18 14 L 82 14 L 82 46 Q 82 70 50 88 Q 18 70 18 46 Z"
          fill="none"
          stroke="var(--color-wine)"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path
          d="M 50 32 L 50 64 M 38 48 L 62 48"
          stroke="var(--color-wine)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}
