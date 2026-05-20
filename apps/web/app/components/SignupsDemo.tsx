"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./Reveal";

const SERVICES = [
  "resend.com",
  "upstash.com",
  "neon.tech",
  "sentry.io",
  "stripe.com",
  "vercel.com",
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function SignupsDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = usePrefersReducedMotion();
  const [inView, setInView] = useState(false);
  const [done, setDone] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (reduce || !inView) return;
    let cancelled = false;
    (async () => {
      while (!cancelled) {
        for (let d = 0; d <= SERVICES.length && !cancelled; d++) {
          setDone(d);
          await sleep(d === SERVICES.length ? 1700 : 760);
        }
        if (cancelled) break;
        await sleep(520);
        setDone(0);
        await sleep(560);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reduce, inView]);

  const total = reduce ? SERVICES.length : done;

  return (
    <div className="fvis su" ref={ref}>
      <div className="su-head">
        <span>signing up · popular SaaS</span>
        <b>
          {Math.min(total, SERVICES.length)}/{SERVICES.length}
        </b>
      </div>
      {SERVICES.map((service, i) => {
        const state =
          i < total ? "done" : !reduce && i === total ? "active" : "queued";
        return (
          <div className={`su-row ${state}`} key={service}>
            <span className="su-mark">{state === "done" ? "✓" : ""}</span>
            <span className="su-name">{service}</span>
            <span className="su-tag">
              {state === "done"
                ? "signed up"
                : state === "active"
                  ? "signing up…"
                  : "queued"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
