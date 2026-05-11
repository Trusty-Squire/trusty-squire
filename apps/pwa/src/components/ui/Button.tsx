import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  children: ReactNode;
}

export function Button({ variant = "primary", className = "", children, ...rest }: ButtonProps) {
  const base = "px-5 py-2.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  const variants = {
    primary: "bg-[color:var(--color-wine)] text-[color:var(--color-cream-soft)] hover:bg-[color:var(--color-wine-deep)]",
    secondary:
      "bg-[color:var(--color-cream)] text-[color:var(--color-amber-black)] border border-[color:var(--color-rule)] hover:bg-[color:var(--color-cream-soft)]",
    ghost: "text-[color:var(--color-amber-black)] hover:bg-[color:var(--color-cream)]",
  };
  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}
