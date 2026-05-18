import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
}

export function Card({ children, className = "" }: CardProps) {
  return (
    <div
      className={`bg-[color:var(--color-surface)] border border-[color:var(--color-border)] rounded-lg p-6 ${className}`}
    >
      {children}
    </div>
  );
}
