"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduce(callback: () => void) {
  const mq = window.matchMedia(REDUCE_QUERY);
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}

/** True when the visitor asked the OS to minimize motion. */
export function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribeReduce,
    () => window.matchMedia(REDUCE_QUERY).matches,
    () => false,
  );
}

/** Fades + lifts its children into view once, when scrolled to. */
export function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.18, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`reveal ${shown ? "in-view" : ""} ${className}`.trim()}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}
