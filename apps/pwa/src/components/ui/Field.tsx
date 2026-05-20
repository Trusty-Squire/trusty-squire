import type { InputHTMLAttributes } from "react";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
}

export function Field({ label, hint, error, id, className = "", ...rest }: FieldProps) {
  const inputId = id ?? rest.name;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  return (
    <div className="block">
      <label htmlFor={inputId} className="block text-sm font-medium mb-1 text-[color:var(--color-text)]">
        {label}
      </label>
      <input
        id={inputId}
        {...rest}
        aria-invalid={error !== undefined}
        aria-describedby={
          error !== undefined ? errorId : hint !== undefined ? hintId : undefined
        }
        className={`w-full px-3 py-2 rounded-md border bg-[color:var(--color-surface)] text-[color:var(--color-text)] border-[color:var(--color-border)] placeholder:text-[color:var(--color-text-muted)] focus:border-[color:var(--color-accent)] focus:outline-none ${className}`}
      />
      {hint !== undefined && error === undefined ? (
        <span id={hintId} className="block text-xs mt-1 text-[color:var(--color-text-soft)]">
          {hint}
        </span>
      ) : null}
      {error !== undefined ? (
        <span id={errorId} role="alert" className="block text-xs mt-1 text-[color:var(--color-accent)]">
          {error}
        </span>
      ) : null}
    </div>
  );
}
