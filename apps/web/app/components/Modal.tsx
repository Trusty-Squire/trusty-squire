"use client";

import { useEffect, type ReactNode } from "react";

// Lightweight modal: backdrop + centered card. Closes on Escape or
// backdrop click. The codebase had no dialog primitive, so this is the
// shared one for vault rotate/delete/allowed-hosts editors.
export function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{title}</h2>
        {subtitle !== undefined && <p className="modal-sub">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}
