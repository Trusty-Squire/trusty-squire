"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./Reveal";

type Tx = {
  name: string;
  amount: string;
  kind: "free" | "approve" | "deny";
  cost: number;
};

const TXS: Tx[] = [
  { name: "Resend", amount: "Free tier", kind: "free", cost: 0 },
  { name: "Vercel Pro", amount: "$20.00 / mo", kind: "approve", cost: 20 },
  { name: "Upstash", amount: "Free tier", kind: "free", cost: 0 },
  { name: "H100 GPU box", amount: "$400.00", kind: "deny", cost: 400 },
];

const BUDGET = 50;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function GuardrailsDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const idxRef = useRef(0);
  const reduce = usePrefersReducedMotion();
  const [inView, setInView] = useState(false);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<"pending" | "face" | "done">("pending");
  const [used, setUsed] = useState(0);

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
        const i = idxRef.current;
        if (i === 0) setUsed(0);
        setIdx(i);
        setPhase("pending");
        const tx = TXS[i];
        await sleep(1000);
        if (cancelled) break;
        if (tx.kind === "approve") {
          setPhase("face");
          await sleep(1050);
          if (cancelled) break;
          setPhase("done");
          setUsed((u) => u + tx.cost);
        } else {
          setPhase("done");
        }
        await sleep(1750);
        idxRef.current = (i + 1) % TXS.length;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reduce, inView]);

  // Reduced motion: render one representative static frame — the blocked one,
  // since proving the guardrail holds is the point of this section.
  const aIdx = reduce ? 3 : idx;
  const aPhase = reduce ? "done" : phase;
  const aUsed = reduce ? 20 : used;

  const tx = TXS[aIdx];
  const done = aPhase === "done";
  const outcome = !done ? "wait" : tx.kind === "deny" ? "no" : "ok";
  const cardClass = !done ? "" : tx.kind === "deny" ? "no" : "ok";
  const pct = Math.min(aUsed / BUDGET, 1) * 100;

  let status: string;
  if (tx.kind === "free") {
    status = done ? "free tier · auto-approved" : "checking tier…";
  } else if (tx.kind === "approve") {
    status = done
      ? "approved"
      : aPhase === "face"
        ? "awaiting your approval"
        : "needs approval";
  } else {
    status = done ? "blocked · would exceed $50 budget" : "needs approval";
  }

  return (
    <div className="fvis gd" ref={ref}>
      <div className="gd-budget">
        <div className="gd-brow">
          <span>monthly budget</span>
          <b>
            ${aUsed.toFixed(2)} / ${BUDGET.toFixed(2)}
          </b>
        </div>
        <div className="meter">
          <i style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className={`gd-card ${cardClass}`.trim()} key={aIdx}>
        <div className="gd-top">
          <span>{tx.name}</span>
          <span className="amt">{tx.amount}</span>
        </div>
        <div className={`gd-status ${outcome === "wait" ? "" : outcome}`.trim()}>
          <span className={`gd-dot ${outcome}`} />
          {status}
          {aPhase === "face" && <span className="gd-face">Face ID</span>}
        </div>
      </div>
    </div>
  );
}
