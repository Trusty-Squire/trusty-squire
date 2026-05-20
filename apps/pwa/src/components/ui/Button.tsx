import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  children: ReactNode;
}

export function Button({ variant = "primary", className = "", children, ...rest }: ButtonProps) {
  const base =
    "px-5 py-2.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  const variants = {
    primary:
      "bg-[color:var(--color-accent-fill)] text-[color:var(--color-accent-contrast)] hover:bg-[color:var(--color-accent-fill-hover)]",
    secondary:
      "bg-[color:var(--color-surface)] text-[color:var(--color-text)] border border-[color:var(--color-border)] hover:bg-[color:var(--color-surface-raised)] hover:border-[color:var(--color-border-strong)]",
    ghost:
      "text-[color:var(--color-text-soft)] hover:bg-[color:var(--color-surface)] hover:text-[color:var(--color-text)]",
  };
  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}
