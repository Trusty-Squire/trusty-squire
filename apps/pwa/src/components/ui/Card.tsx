import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
}

export function Card({ children, className = "" }: CardProps) {
  return (
    <div
      className={`bg-[color:var(--color-cream-soft)] border border-[color:var(--color-rule)] rounded-xl p-6 ${className}`}
    >
      {children}
    </div>
  );
}
